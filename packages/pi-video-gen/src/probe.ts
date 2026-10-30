import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { CancelledError } from './providers/task.js';

const execFileAsync = promisify(execFile);
const cache = new Map<string, { expires: number; output: string }>();
type InFlightProbe = {
  controller: AbortController;
  promise: Promise<string | undefined>;
  waiters: number;
  settled: boolean;
};
const inFlight = new Map<string, InFlightProbe>();

function expectedFailure(error: unknown): boolean {
  const failure = error as { code?: unknown; killed?: unknown; signal?: unknown } | undefined;
  return (
    (typeof failure?.code === 'number' && failure.code !== 0) ||
    ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENOEXEC', 'EISDIR'].includes(String(failure?.code)) ||
    (failure?.code == null && (failure?.killed === true || typeof failure?.signal === 'string'))
  );
}

/** Bound even filesystem waits, which cannot themselves be aborted. */
export async function waitForProbe<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<T | undefined> {
  const remaining = deadline - Date.now();
  if (signal?.aborted || remaining <= 0) {
    void operation.catch(() => {});
    if (signal?.aborted) throw new CancelledError();
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve, reject) => {
        timer = setTimeout(() => resolve(undefined), remaining);
        onAbort = () => reject(new CancelledError());
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Share active probes; a caller only stops the process when no other callers need it. */
export async function probeCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeout = 5000,
  parentDeadline?: number,
): Promise<string | undefined> {
  if (signal?.aborted) throw new CancelledError();
  const deadline = Math.min(parentDeadline ?? Infinity, Date.now() + timeout);
  if (Date.now() >= deadline) return undefined;
  const info = await waitForProbe(
    stat(command).catch((error) => {
      if (!signal?.aborted && Date.now() < deadline && !expectedFailure(error)) {
        console.error('[pi-video-gen] command probe stat failed');
      }
      return undefined;
    }),
    signal,
    deadline,
  );
  if (signal?.aborted) throw new CancelledError();
  if (Date.now() >= deadline) return undefined;
  const key = JSON.stringify([
    command,
    args,
    timeout,
    process.cwd(),
    process.env.PATH,
    info && [info.ino, info.size, info.mtimeMs, info.ctimeMs],
  ]);
  if (signal?.aborted) throw new CancelledError();
  if (Date.now() >= deadline) return undefined;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.output;
  let active = inFlight.get(key);
  if (!active) {
    const controller = new AbortController();
    const probe: InFlightProbe = {
      controller,
      waiters: 0,
      settled: false,
      promise: execFileAsync(command, args, {
        encoding: 'utf8',
        timeout: Math.max(1, deadline - Date.now()),
        maxBuffer: 1024 * 1024,
        signal: controller.signal,
        killSignal: 'SIGKILL',
      })
        .then(({ stdout }) => {
          if (controller.signal.aborted) return undefined;
          if (cache.size >= 32) cache.delete(cache.keys().next().value!);
          cache.set(key, { expires: Date.now() + 30_000, output: stdout });
          return stdout;
        })
        .catch((error) => {
          if (!controller.signal.aborted && !expectedFailure(error)) {
            console.error('[pi-video-gen] command probe failed');
          }
          return undefined;
        })
        .finally(() => {
          probe.settled = true;
          if (inFlight.get(key) === probe) inFlight.delete(key);
        }),
    };
    inFlight.set(key, probe);
    active = probe;
  }
  const probe = active;
  probe.waiters++;
  try {
    return await waitForProbe(probe.promise, signal, deadline);
  } finally {
    probe.waiters--;
    if (probe.waiters === 0 && !probe.settled) {
      if (inFlight.get(key) === probe) inFlight.delete(key);
      probe.controller.abort();
    }
  }
}
