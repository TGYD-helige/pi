import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const [entry, configPath, phase, url] = process.argv.slice(2);
const { DevToolsClient, default: browserUseExtension } = await import(entry);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const client = new DevToolsClient(config);
const tools = new Map(),
  commands = new Map(),
  handlers = new Map();
let active = [];
browserUseExtension({
  registerTool(tool) {
    tools.set(tool.name, tool);
    active.push(tool.name);
  },
  registerCommand(name, command) {
    commands.set(name, command);
  },
  on(name, handler) {
    handlers.set(name, handler);
  },
  getAllTools() {
    return [...tools.values()];
  },
  getActiveTools() {
    return active;
  },
  setActiveTools(names) {
    active = names;
  },
});
const context = { cwd: process.env.PI_AGENT_HOME, isProjectTrusted: () => false };
async function call(name, args) {
  const tool = tools.get(`browser_${name}`);
  if (!tool) throw Error(`Missing public browser tool ${name}`);
  return tool.execute('e2e', args, undefined, undefined, context);
}
const text = (result) =>
  result.content
    ?.filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n') ?? '';
const value = (result) => {
  if (result.isError) throw Error('Browser evaluation failed');
  const match = /```json\s*([\s\S]*?)\s*```/.exec(text(result));
  if (!match) throw Error('Missing browser evaluation result');
  return JSON.parse(match[1]);
};
try {
  if (phase === 'cleanup') {
    await client.sessionControl('release');
  } else {
    await handlers.get('session_start')({}, context);
    if (phase === 'disabled') {
      assert.equal(tools.has('browser_session'), false);
      assert.equal(commands.has('browser-session'), false);
      console.log(JSON.stringify({ state: 'direct' }));
    } else {
      if (!commands.has('browser-session')) throw Error('Missing matching browser-session command');
      if (phase === 'discover') {
        const result = await call('session', { action: 'status' });
        console.log(text(result));
      } else {
        const pages =
          phase !== 'resume' ? await call('new_page', { url }) : await call('list_pages', {});
        const page = text(pages)
          .split('\n')
          .find((line) => line.includes(url));
        const match = /^(\d+):/.exec(page ?? '');
        if (!match) throw Error('Original QR page not found');
        if (phase !== 'resume' && url.startsWith('about:blank#')) {
          value(
            await call('evaluate_script', {
              pageId: Number(match[1]),
              function:
                '() => { globalThis.handshake = Math.random().toString(36).slice(2); globalThis.ticks = 0; setInterval(() => globalThis.ticks++, 20); return true; }',
            }),
          );
        }
        const data = value(
          await call('evaluate_script', {
            pageId: Number(match[1]),
            function: '() => ({handshake:globalThis.handshake,ticks:globalThis.ticks})',
          }),
        );
        const result = await call('session', {
          action:
            phase === 'ordinary'
              ? 'status'
              : ['retain', 'crash-retain'].includes(phase)
                ? 'retain'
                : 'release',
        });
        if (result.isError) throw Error(text(result));
        const status = JSON.parse(text(result));
        if (phase === 'retain') {
          const repeated = await call('session', { action: 'retain' });
          assert.equal(
            JSON.parse(text(repeated)).expiresAt,
            status.expiresAt,
            'Retain must not silently renew the handoff',
          );
        }
        if (phase === 'crash-retain') {
          // Exit without session_shutdown/detach, as when the Pi client process dies.
          await new Promise(() =>
            process.stdout.write(`${JSON.stringify({ ...data, ...status })}\n`, () =>
              process.exit(0),
            ),
          );
        }
        console.log(JSON.stringify({ ...data, ...status }));
      }
    }
  }
} finally {
  await handlers.get('session_shutdown')?.();
  await client.close();
}
