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

/** Share active probes; a caller only stops the process when no other callers need it. */
export async function probeCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeout = 5000,
): Promise<string | undefined> {
  if (signal?.aborted) throw new CancelledError();
  const info = await stat(command).catch((error) => {
    if (!expectedFailure(error)) console.error('[pi-video-gen] command probe stat failed');
    return undefined;
  });
  const key = JSON.stringify([
    command,
    args,
    timeout,
    process.cwd(),
    process.env.PATH,
    info && [info.ino, info.size, info.mtimeMs, info.ctimeMs],
  ]);
  if (signal?.aborted) throw new CancelledError();
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
        timeout,
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
  let removeAbortListener = () => {};
  try {
    if (!signal) return await probe.promise;
    return await new Promise<string | undefined>((resolve, reject) => {
      const onAbort = () => reject(new CancelledError());
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      probe.promise.then(resolve, reject);
      if (signal.aborted) onAbort();
    });
  } finally {
    removeAbortListener();
    probe.waiters--;
    if (probe.waiters === 0 && !probe.settled) {
      if (inFlight.get(key) === probe) inFlight.delete(key);
      probe.controller.abort();
    }
  }
}
