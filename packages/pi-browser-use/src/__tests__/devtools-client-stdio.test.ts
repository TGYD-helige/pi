import { once } from 'node:events';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSubprocessEnv } from '../config.js';
import { DevToolsClient } from '../index.js';

const originalExecPath = process.execPath;
const originalPath = process.env.PATH;

describe('DevToolsClient real stdio transport', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    process.execPath = originalExecPath;
    process.env.PATH = originalPath;
  });

  it('enforces allowlists and blocklists in the actual subprocess environment', async () => {
    vi.stubEnv('DISPLAY', ':42');
    vi.stubEnv('SHELL', 'must-not-inherit');
    vi.stubEnv('MY_ALLOWED_VAR', 'explicitly-allowed');
    vi.stubEnv('MY_BLOCKED_VAR', 'must-not-inherit');
    vi.stubEnv('SECRET_API_TOKEN', 'must-not-inherit');
    const transport = new StdioClientTransport({
      command: originalExecPath,
      args: [
        '-e',
        `console.error(JSON.stringify(Object.fromEntries(
          ['PATH', 'DISPLAY', 'SHELL', 'MY_ALLOWED_VAR', 'MY_BLOCKED_VAR', 'SECRET_API_TOKEN']
            .map(name => [name, process.env[name]])
        ))); process.stdin.resume();`,
      ],
      env: buildSubprocessEnv(
        process.env,
        ['MY_ALLOWED_VAR', 'MY_BLOCKED_VAR'],
        ['PATH', 'MY_BLOCKED_VAR'],
      ) as Record<string, string>,
      stderr: 'pipe',
    });
    const output = once(transport.stderr!, 'data');
    try {
      await transport.start();
      const [chunk] = await output;
      expect(JSON.parse(String(chunk))).toEqual({
        DISPLAY: ':42',
        MY_ALLOWED_VAR: 'explicitly-allowed',
      });
    } finally {
      await transport.close();
    }
  });

  it('preserves a real spawn error code when the Node executable is missing', async () => {
    process.execPath = '/definitely-missing/pi-browser-use-node';
    const client = new DevToolsClient({ headless: true, sessionMode: 'isolated' });

    await expect(client.connect()).rejects.toThrow(
      'Browser connection failed. MCP subprocess failed (ENOENT).',
    );
  });

  it.each([
    true,
    false,
  ])('initializes real MCP tools with ambient npx absent and page routing %s', async (experimentalPageIdRouting) => {
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    const client = new DevToolsClient({
      headless: true,
      sessionMode: 'isolated',
      experimentalPageIdRouting,
      ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    });

    try {
      const tools = await client.listAllTools();

      expect(tools.length).toBeGreaterThan(0);
      expect(tools.some((tool) => tool.name === 'navigate_page')).toBe(true);
      const click = tools.find((tool) => tool.name === 'click');
      expect(click?.inputSchema.required?.includes('pageId') ?? false).toBe(
        experimentalPageIdRouting,
      );
    } finally {
      await client.close();
    }
  }, 60_000);
});
