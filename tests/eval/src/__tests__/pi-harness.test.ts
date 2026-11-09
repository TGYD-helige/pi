import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drivePrompt, type HarnessConfig, setupHarness } from '../pi-harness.js';

let dir: string;
const config: HarnessConfig = {
  provider: 'fixture',
  model: 'fixture',
  baseUrl: '',
  api: 'openai-completions',
  apiKeyEnv: 'UNUSED',
  thinking: 'off',
  timeoutMs: 5000,
};
async function cli(events: unknown[], code = 0) {
  const script = path.join(dir, 'pi');
  await writeFile(
    script,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join('\n'))}, () => process.exit(${code}));\n`,
  );
  await chmod(script, 0o755);
}

describe('Pi evaluation harness', () => {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pi-eval-harness-'));
    vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env.PATH}`);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('scores only the last answer and collects usage across turns', async () => {
    await cli([
      { type: 'turn_start' },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Success!' }],
          usage: { totalTokens: 10 },
        },
      },
      {
        type: 'tool_execution_end',
        toolName: 'browser_click',
        isError: true,
        result: { content: [{ type: 'text', text: 'failed' }] },
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Could not complete.' }],
          usage: { totalTokens: 20 },
        },
      },
    ]);
    const result = await drivePrompt(
      { cfgDir: dir, cleanup() {} },
      config,
      'task',
      'browser_click',
    );
    expect(result).toMatchObject({
      answer: 'Could not complete.',
      totalTokens: 30,
      sawToolError: true,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
  it('writes an explicit environment reference instead of using the variable name as the credential', async () => {
    const harness = await setupHarness(config, { settings: {} });
    try {
      const models = JSON.parse(await readFile(path.join(harness.cfgDir, 'models.json'), 'utf8'));
      expect(models.providers.fixture.apiKey).toBe('$UNUSED');
    } finally {
      harness.cleanup();
    }
  });

  it('fails a nonzero exit even if earlier events claimed success', async () => {
    await cli(
      [
        {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Success' }] },
        },
      ],
      1,
    );
    const result = await drivePrompt({ cfgDir: dir, cleanup() {} }, config, 'task', '');
    expect(result.failureMode).toBe('crash');
  });

  it('does not expose provider errors and does not treat missing usage as zero', async () => {
    await cli([
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          errorMessage: 'token=private-secret',
          stopReason: 'error',
        },
      },
    ]);
    const result = await drivePrompt({ cfgDir: dir, cleanup() {} }, config, 'task', '');
    expect(result.failureMode).toBe('crash');
    expect(JSON.stringify(result)).not.toContain('private-secret');
    expect(result.totalTokens).toBeUndefined();
  });

  it('stops a hung Pi invocation at the deadline', async () => {
    const script = path.join(dir, 'pi');
    await writeFile(script, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n');
    await chmod(script, 0o755);
    const result = await drivePrompt(
      { cfgDir: dir, cleanup() {} },
      { ...config, timeoutMs: 100 },
      'task',
      '',
    );
    expect(result.failureMode).toBe('crash');
    expect(result.durationMs).toBeLessThan(2000);
  });

  it('runs outside the repository with isolated Pi data and configuration directories', async () => {
    const script = path.join(dir, 'pi');
    await writeFile(
      script,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify({cwd:process.cwd(),home:process.env.PI_AGENT_HOME,config:process.env.PI_CODING_AGENT_DIR})}]}}));`,
    );
    await chmod(script, 0o755);
    const result = await drivePrompt({ cfgDir: dir, cleanup() {} }, config, 'task', '');
    expect(JSON.parse(result.answer)).toEqual({
      cwd: await realpath(path.join(dir, 'workspace')),
      home: dir,
      config: dir,
    });
  });
  it('preserves the explicitly selected credential environment variable', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-key');
    const script = path.join(dir, 'pi');
    await writeFile(
      script,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:process.env.OPENAI_API_KEY || 'missing'}]}}));`,
    );
    await chmod(script, 0o755);
    const result = await drivePrompt(
      { cfgDir: dir, cleanup() {} },
      { ...config, apiKeyEnv: 'OPENAI_API_KEY' },
      'task',
      '',
    );
    expect(result.answer).toBe('synthetic-key');
  });
  it('bounds diagnostic tool output while retaining the newest result', async () => {
    await cli([
      ...['first', 'middle', 'last'].map((toolName) => ({
        type: 'tool_execution_end',
        toolName,
        result: { content: [{ type: 'text', text: 'x'.repeat(25000) }] },
      })),
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
      },
    ]);
    const result = await drivePrompt({ cfgDir: dir, cleanup() {} }, config, 'task', '');
    expect(result.toolResults?.map((tool) => tool.toolName)).toEqual(['last']);
    expect(result.toolCalls).toBe(3);
  });
  it('bounds retained events without failing on repeated streaming snapshots', async () => {
    await cli([
      ...Array.from({ length: 30 }, () => ({
        type: 'message_update',
        partial: 'x'.repeat(100000),
      })),
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
      },
    ]);
    const result = await drivePrompt({ cfgDir: dir, cleanup() {} }, config, 'task', '');
    expect(result).toMatchObject({ failureMode: 'ok', answer: 'Done' });
  });
  it('retains completed work and reported usage when Pi exits unsuccessfully', async () => {
    await cli(
      [
        { type: 'turn_start' },
        {
          type: 'tool_execution_end',
          toolName: 'browser_click',
          result: { content: [{ type: 'text', text: 'clicked' }] },
        },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Done' }],
            usage: { totalTokens: 15 },
          },
        },
      ],
      1,
    );
    const result = await drivePrompt({ cfgDir: dir, cleanup() {} }, config, 'task', '');
    expect(result).toMatchObject({
      failureMode: 'crash',
      answer: '',
      turns: 1,
      toolCalls: 1,
      totalTokens: 15,
    });
    expect(result.toolResults?.[0]).toMatchObject({ toolName: 'browser_click', text: 'clicked' });
    expect(result.observed).toContain('clicked');
  });

  it('retains completed tool events when the invocation hits its deadline', async () => {
    await writeFile(
      path.join(dir, 'pi'),
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'tool_execution_end',toolName:'browser_click',result:{content:[{type:'text',text:'clicked'}]}})+String.fromCharCode(10),()=>setInterval(()=>{},1000));`,
    );
    await chmod(path.join(dir, 'pi'), 0o755);
    const result = await drivePrompt(
      { cfgDir: dir, cleanup() {} },
      { ...config, timeoutMs: 1500 },
      'task',
      '',
    );
    expect(result).toMatchObject({ failureMode: 'crash', toolCalls: 1 });
    expect(result.error).toMatch(/deadline/);
    expect(result.toolResults?.[0]?.text).toBe('clicked');
  });
});
