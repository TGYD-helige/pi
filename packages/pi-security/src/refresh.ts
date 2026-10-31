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
async function readInLane<T>(
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  while (active) await waitUntilIdle(signal);
  signal.throwIfAborted();
  active = true;
  const operation = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return read(signal);
  });
  const release = () => {
    active = false;
    for (const wake of [...idleWaiters]) wake();
  };
  void operation.then(release, release);
  return waitFor(operation, signal);
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
type Member = { deadline: number; signal?: AbortSignal; deliver: (outcome: Outcome) => void };
type Batch = {
  started: boolean;
  finished: boolean;
  controller: AbortController;
  members: Set<Member>;
};
const collecting = new Map<string | symbol, Batch>();
const timeout = () => new Error('Security configuration refresh timed out.');

/** Only callers admitted before a read starts share it; later calls always get fresh policy. */
export async function refreshConfiguration<T>(
  read: (signal: AbortSignal) => Promise<T>,
  caller?: AbortSignal,
  scope?: string,
): Promise<T> {
  caller?.throwIfAborted();
  const key = scope ?? Symbol();
  let batch = collecting.get(key);
  if (!batch || batch.started || batch.controller.signal.aborted) {
    batch = {
      started: false,
      finished: false,
      controller: new AbortController(),
      members: new Set(),
    };
    collecting.set(key, batch);
    const current = batch;
    const finish = (outcome: Outcome) => {
      current.finished = true;
      if (collecting.get(key) === current) collecting.delete(key);
      for (const member of [...current.members]) member.deliver(outcome);
    };
    void readInLane(async (signal) => {
      for (const member of [...current.members]) {
        if (member.signal?.aborted || Date.now() >= member.deadline)
          member.deliver({ ok: false, error: timeout() });
      }
      signal.throwIfAborted();
      current.started = true;
      return read(signal);
    }, current.controller.signal).then(
      (value) => finish({ ok: true, value }),
      (error: unknown) => finish({ ok: false, error }),
    );
  }
  const current = batch;
  return new Promise<T>((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    let done = false;
    let relay: ReturnType<typeof addAbortListener> | undefined;
    const member: Member = { deadline, ...(caller ? { signal: caller } : {}), deliver };
    const timer = setTimeout(() => deliver({ ok: false, error: timeout() }), 5_000);
    timer.unref();
    function deliver(outcome: Outcome) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      relay?.[Symbol.dispose]();
      current.members.delete(member);
      if (current.members.size === 0 && !current.finished) {
        current.controller.abort(new Error('No active configuration readers remain.'));
        if (collecting.get(key) === current) collecting.delete(key);
      }
      if (caller?.aborted) reject(caller.reason);
      else if (Date.now() >= deadline) reject(timeout());
      else if (outcome.ok) resolve(outcome.value as T);
      else reject(outcome.error);
    }
    current.members.add(member);
    if (caller)
      relay = addAbortListener(caller, () => deliver({ ok: false, error: caller.reason }));
  });
}
