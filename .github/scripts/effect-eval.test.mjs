import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const script = fileURLToPath(new URL('./effect-eval.sh', import.meta.url));

describe('effect eval workflow', () => {
  for (const target of ['browser', 'memory']) {
    it(`builds both revisions and publishes ${target} comparisons from the workspace`, async () => {
      const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-effect-workflow-')));
      try {
        const bin = path.join(dir, 'bin');
        const workspace = path.join(dir, 'workspace');
        await mkdir(bin);
        await mkdir(workspace);
        const fake = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const command = path.basename(process.argv[1]); const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify({command,args,cwd:process.cwd(),chrome:process.env.CHROME_BIN})+'\\n');
if(command==='git' && args[0]==='worktree') fs.mkdirSync(args[3],{recursive:true});
if(command==='npx') { const dir=path.join(process.env.RUNNER_TEMP,'chrome-install'); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'chrome'),'fixture'); }
if(command==='pnpm' && args.includes('compare')) { const file=path.join(process.env.GITHUB_WORKSPACE,'tests/eval',args.at(-1)); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,'Report '+path.basename(file)+'\\n'); }
`;
        for (const name of ['git', 'pnpm', 'npx']) {
          await writeFile(path.join(bin, name), fake);
          await chmod(path.join(bin, name), 0o755);
        }
        const summary = path.join(dir, 'summary.md');
        await run('bash', [script], {
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            TARGET: target,
            GITHUB_WORKSPACE: workspace,
            RUNNER_TEMP: dir,
            GITHUB_STEP_SUMMARY: summary,
            BASE_REF: 'fixture-base',
            TRIALS: '3',
            TASKS: '2',
            PI_INTEGRATION_BASE_URL: 'http://fixture.invalid',
            PI_INTEGRATION_API_KEY: 'fixture',
            CALLS: path.join(dir, 'calls.jsonl'),
          },
        });
        const calls = (await readFile(path.join(dir, 'calls.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map(JSON.parse);
        const evaluations = calls.filter(
          (call) =>
            call.command === 'pnpm' &&
            call.args.includes(target === 'browser' ? 'eval:browser' : 'eval:memory:product'),
        );
        expect(evaluations).toHaveLength(target === 'browser' ? 2 : 3);
        expect(evaluations.every((call) => call.cwd === workspace)).toBe(true);
        expect(evaluations[0].args).toContain(path.join(dir, 'pi-eval-base'));
        expect(
          calls.some(
            (call) =>
              call.command === 'pnpm' &&
              call.cwd === path.join(dir, 'pi-eval-base') &&
              call.args.includes('build'),
          ),
        ).toBe(true);
        expect(await readFile(summary, 'utf8')).toBe(
          target === 'browser'
            ? 'Report comparison.md\n'
            : 'Report comparison.md\nReport memory-benefit.md\n',
        );
        if (target === 'browser')
          expect(
            evaluations.every((call) => call.chrome === path.join(dir, 'chrome-install/chrome')),
          ).toBe(true);
        else expect(evaluations[2].args).toContain('--without-memory');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('browser workflow summary', () => {
  it('prints the evaluated model and completion metrics from the result file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-effect-summary-'));
    try {
      const file = path.join(dir, 'browser.json');
      await writeFile(
        file,
        JSON.stringify({
          configuration: { model: 'fixture/model' },
          summary: {
            n: 2,
            successRate: 0.5,
            nonCrashSuccessRate: 1,
            consistentTaskRate: 0,
            avgTurns: 2,
            avgToolCalls: 3,
            failureMix: { ok: 1, crash: 1 },
          },
          rows: [],
        }),
      );
      const { stdout } = await run(process.execPath, [
        fileURLToPath(new URL('./effect-eval-summary.mjs', import.meta.url)),
        file,
      ]);
      expect(stdout).toContain('fixture/model');
      expect(stdout).toContain('**0.500** (2 trials, crashes included)');
      expect(stdout).toContain('"crash":1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
