import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { CancelledError } from './providers/task.js';

const execFileAsync = promisify(execFile);
const cache = new Map<string, { expires: number; output: string }>();

/** Cache successful probes briefly; file replacement invalidates absolute-path entries. */
export async function probeCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeout = 5000,
): Promise<string | undefined> {
  if (signal?.aborted) throw new CancelledError();
  const info = await stat(command).catch(() => undefined);
  const key = JSON.stringify([
    command,
    args,
    process.cwd(),
    process.env.PATH,
    info && [info.ino, info.size, info.mtimeMs, info.ctimeMs],
  ]);
  if (signal?.aborted) throw new CancelledError();
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.output;
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 1024 * 1024,
      signal,
      killSignal: 'SIGKILL',
    });
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + 30_000, output: stdout });
    return stdout;
  } catch {
    if (signal?.aborted) throw new CancelledError();
    return undefined;
  }
}
