import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const tsx = createRequire(path.join(root, 'package.json')).resolve('tsx/cli');

describe('memory product runner', () => {
  it('allows real memory reads in the follow-up session rather than forcing simulated tool calls', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-eval-product-runner-'));
    try {
      const cli = path.join(dir, 'pi');
      await writeFile(
        cli,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if(args.includes('--version')) { console.log('fixture'); process.exit(0); }
if(args[0] === 'install') process.exit(0);
const tools = args[args.indexOf('--tools') + 1];
const answer = tools === 'memory_read' ? { language: 'Spanish' } : { language: null };
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(answer)}]}}));
`,
      );
      await chmod(cli, 0o755);
      const output = path.join(dir, 'result.json');
      await run(
        process.execPath,
        [
          tsx,
          path.join(root, 'memory/run-product.ts'),
          '--task',
          'recall-preference',
          '--trials',
          '1',
          '--output',
          output,
        ],
        {
          env: {
            ...process.env,
            PATH: `${dir}${path.delimiter}${process.env.PATH}`,
            PI_INTEGRATION_BASE_URL: 'http://eval.invalid/v1',
            PI_INTEGRATION_API_KEY: 'fixture',
          },
          timeout: 10000,
        },
      );
      const result = JSON.parse(await readFile(output, 'utf8'));
      expect(result.rows[0].success).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
