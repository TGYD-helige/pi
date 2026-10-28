import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const [entry, configPath, phase, url] = process.argv.slice(2);
let step = 'load-extension';
let SessionError;
try {
  const { DevToolsClient, BrowserSessionError, default: browserUseExtension } = await import(entry);
  SessionError = BrowserSessionError;
  step = 'configure';
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const client = new DevToolsClient(config);
  const tools = new Map(),
    commands = new Map(),
    handlers = new Map();
  let active = [];
  step = 'register-extension';
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
    const result = await tool.execute('e2e', args, undefined, undefined, context);
    if (result.isError) {
      const error = Error('Browser tool execution failed');
      const message = (result.content ?? [])
        .filter((item) => item.type === 'text')
        .map((item) => item.text ?? '')
        .join('\n');
      const status = /(?:HTTP|server response:)\s*(\d{3})/i.exec(message)?.[1];
      if (status) error.code = `HTTP_${status}`;
      else if (/too many|concurren|quota|rate.limit/i.test(message)) error.code = 'PROVIDER_LIMIT';
      else if (/target closed|connection closed|session closed|disconnected/i.test(message)) error.code = 'BROWSER_CLOSED';
      else if (/timeout|timed out/i.test(message)) error.code = 'BROWSER_TIMEOUT';
      const operation = /Protocol error \(([A-Za-z]+\.[A-Za-z]+)\)/.exec(message)?.[1];
      if (operation) error.operation = operation;
      throw error;
    }
    return result;
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
      step = 'session-start';
      await handlers.get('session_start')({}, context);
      if (phase === 'disabled') {
        assert.equal(tools.has('browser_session'), false);
        assert.equal(commands.has('browser-session'), false);
        console.log(JSON.stringify({ state: 'direct' }));
      } else {
        if (!commands.has('browser-session'))
          throw Error('Missing matching browser-session command');
        if (phase === 'discover') {
          const result = await call('session', { action: 'status' });
          console.log(text(result));
        } else {
          step = phase === 'resume' ? 'list-pages' : 'open-page';
          const pages =
            phase !== 'resume' ? await call('new_page', { url }) : await call('list_pages', {});
          const page = text(pages)
            .split('\n')
            .find((line) => line.includes(url));
          const match = /^(\d+):/.exec(page ?? '');
          if (!match) throw Error('Original QR page not found');
          if (phase !== 'resume' && url.startsWith('about:blank#')) {
            step = 'initialize-memory';
            value(
              await call('evaluate_script', {
                pageId: Number(match[1]),
                function:
                  '() => { globalThis.handshake = Math.random().toString(36).slice(2); globalThis.ticks = 0; setInterval(() => globalThis.ticks++, 20); return true; }',
              }),
            );
          }
          step = 'read-memory';
          const data = value(
            await call('evaluate_script', {
              pageId: Number(match[1]),
              function: '() => ({handshake:globalThis.handshake,ticks:globalThis.ticks})',
            }),
          );
          step = 'session-control';
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
} catch (error) {
  const diagnostic = {
    step,
    name: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error?.name ?? '') ? error.name : 'Error',
  };
  if (/^[A-Z_0-9]{1,64}$/.test(error?.code ?? '')) diagnostic.code = error.code;
  if (/^[A-Za-z]+\.[A-Za-z]+$/.test(error?.operation ?? '')) diagnostic.operation = error.operation;
  const property = /reading ['"]([A-Za-z_$][\w$]*)/.exec(error?.message ?? '')?.[1];
  if (property) diagnostic.property = property;
  const module = /Cannot find (?:module|package) ['"]([^'"]+)['"]/
    .exec(error?.message ?? '')?.[1]
    ?.split('/')
    .pop();
  if (module && /^[\w@.-]{1,100}$/.test(module)) diagnostic.module = module;
  if (
    (SessionError && error instanceof SessionError) ||
    [
      'Original QR page not found',
      'Browser evaluation failed',
      'Missing browser evaluation result',
    ].includes(error?.message)
  )
    diagnostic.message = error.message.slice(0, 512);
  console.error(`PI_BROWSER_SESSION_TEST_ERROR ${JSON.stringify(diagnostic)}`);
  process.exitCode = 1;
}
