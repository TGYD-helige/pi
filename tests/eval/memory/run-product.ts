import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { drivePrompt, parseCommonArgs, setupHarness, toHarnessConfig } from '../src/pi-harness.js';
import { resultMetadata, summarize, type TrialRow } from '../src/results.js';
import { gradeMemoryTask, MEMORY_TASKS, type MemoryState } from './tasks.js';

async function readState(dir: string): Promise<MemoryState> {
  const read = async (name: string) => {
    const file = path.join(dir, name);
    if ((await stat(file)).size > 64_000) throw new Error('Memory fixture exceeded size limit.');
    return (await readFile(file, 'utf8'))
      .split('\n§\n')
      .map((entry) => entry.trim())
      .filter(Boolean);
  };
  return { memory: await read('MEMORY.md'), user: await read('USER.md') };
}

async function main() {
  const args = parseCommonArgs({ model: 'deepseek-v4-flash', timeoutMs: 180_000 });
  if (args.useDefaultPi) throw new Error('Product eval requires isolated configuration.');
  const memoryEnabled = !process.argv.includes('--without-memory');
  const hcfg = toHarnessConfig(args);
  let tasks = args.taskId ? MEMORY_TASKS.filter((task) => task.id === args.taskId) : MEMORY_TASKS;
  if (args.tasks > 0) tasks = tasks.slice(0, args.tasks);
  if (!tasks.length) throw new Error('No tasks selected.');
  const metadata = {
    expectedTrials: tasks.length * args.trials,
    ...resultMetadata(
      'memory-product-v1',
      ['memory/tasks.ts', 'memory/run-product.ts'],
      args.packageRoot,
      `${args.provider}/${args.model}`,
      args.thinking,
      hcfg,
    ),
    memoryEnabled,
  };
  const rows: Array<TrialRow & { answer: string; state: MemoryState; sessions: unknown[] }> = [];
  const output = path.resolve(
    args.output ||
      path.join(
        import.meta.dirname,
        '..',
        'results',
        memoryEnabled ? 'memory-product.json' : 'memory-control.json',
      ),
  );
  const save = async () => {
    await mkdir(path.dirname(output), { recursive: true });
    const temporary = `${output}.tmp-${process.pid}`;
    await writeFile(
      temporary,
      JSON.stringify(
        {
          ...metadata,
          complete: rows.length === metadata.expectedTrials,
          summary: summarize(rows),
          rows,
        },
        null,
        2,
      ),
    );
    await rename(temporary, output);
  };
  await save();
  for (const task of tasks) {
    for (let trial = 1; trial <= args.trials; trial++) {
      const dir = await mkdtemp(path.join(tmpdir(), 'pi-memory-product-'));
      try {
        await writeFile(path.join(dir, 'MEMORY.md'), task.seed.memory.join('\n§\n'));
        await writeFile(path.join(dir, 'USER.md'), task.seed.user.join('\n§\n'));
        const harness = await setupHarness(hcfg, {
          ...(memoryEnabled ? { pkg: 'pi-memory' } : {}),
          settings: {
            'pi-memory': {
              dataDir: dir,
              ...(task.memoryCharLimit ? { memoryCharLimit: task.memoryCharLimit } : {}),
              dreaming: { enabled: false },
            },
          },
        });
        try {
          const sessions = [];
          for (const prompt of task.sessions) {
            const drive = await drivePrompt(
              harness,
              hcfg,
              prompt,
              memoryEnabled ? 'memory_read,memory_add,memory_replace,memory_remove' : '',
            );
            sessions.push(drive);
            if (drive.failureMode !== 'ok') break;
          }
          if (sessions.every((session) => session.failureMode === 'ok')) {
            sessions.push(
              await drivePrompt(
                harness,
                hcfg,
                `${task.question}\nAnswer using only remembered facts. If a fact is unknown or forgotten, use null. Return ONLY a JSON object with exactly these keys: ${Object.keys(task.expected).join(', ')}.`,
                memoryEnabled ? 'memory_read' : '',
              ),
            );
          }
          const answer = sessions.at(-1)!.answer;
          const state = await readState(dir);
          const crashed = sessions.some((session) => session.failureMode !== 'ok');
          const success = !crashed && gradeMemoryTask(task, answer, state, memoryEnabled) ? 1 : 0;
          const failureMode = crashed
            ? 'crash'
            : success
              ? 'ok'
              : sessions.some((session) => session.sawToolError)
                ? 'tool-error'
                : 'check-failed';
          rows.push({
            task: task.id,
            trial,
            success,
            failureMode,
            answer,
            state,
            sessions,
            turns: sessions.reduce((sum, session) => sum + session.turns, 0),
            toolCalls: sessions.reduce((sum, session) => sum + session.toolCalls, 0),
            durationMs: sessions.reduce((sum, session) => sum + session.durationMs, 0),
            ...(sessions.every((session) => session.totalTokens !== undefined)
              ? { totalTokens: sessions.reduce((sum, session) => sum + session.totalTokens!, 0) }
              : {}),
          });
          process.stderr.write(
            `[eval:memory-product] ${task.id} trial=${trial} success=${success} mode=${failureMode}\n`,
          );
          await save();
        } finally {
          harness.cleanup();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
  process.stderr.write(`[eval:memory-product] ${JSON.stringify(summarize(rows))}\n`);
}

main().catch(() => {
  process.stderr.write(
    '[eval:memory-product] Evaluation setup failed. Check provider configuration and the Pi build.\n',
  );
  process.exitCode = 1;
});
