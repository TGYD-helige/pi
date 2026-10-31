import { addAbortListener } from 'node:events';

let active = false;
const idleWaiters = new Set<() => void>();

function waitUntilIdle(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onIdle = () => {
      cleanup();
      resolve();
    };
    const abort = addAbortListener(signal, () => {
      cleanup();
      reject(signal.reason);
    });
    const cleanup = () => {
      idleWaiters.delete(onIdle);
      abort[Symbol.dispose]();
    };
    idleWaiters.add(onIdle);
  });
}

async function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cleanup: ReturnType<typeof addAbortListener> | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cleanup = addAbortListener(signal, () => reject(signal.reason));
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    cleanup?.[Symbol.dispose]();
  }
}

/** Serialize raw I/O, not authorization results: every admitted caller reads fresh policy. */
export async function refreshConfiguration<T>(
  read: (signal: AbortSignal) => Promise<T>,
  caller?: AbortSignal,
): Promise<T> {
  caller?.throwIfAborted();
  const controller = new AbortController();
  const deadline = Date.now() + 5_000;
  const expire = () => controller.abort(new Error('Security configuration refresh timed out.'));
  const timer = setTimeout(expire, 5_000);
  timer.unref();
  const relay = caller
    ? addAbortListener(caller, () => controller.abort(caller.reason))
    : undefined;
  const check = () => {
    if (Date.now() >= deadline) expire();
    controller.signal.throwIfAborted();
  };
  try {
    while (active) {
      await waitUntilIdle(controller.signal);
      check();
    }
    check();
    active = true;
    const operation = Promise.resolve().then(() => {
      check();
      return read(controller.signal);
    });
    const release = () => {
      active = false;
      for (const wake of [...idleWaiters]) wake();
    };
    void operation.then(release, release);
    const result = await waitFor(operation, controller.signal);
    check();
    return result;
  } finally {
    clearTimeout(timer);
    relay?.[Symbol.dispose]();
  }
}
