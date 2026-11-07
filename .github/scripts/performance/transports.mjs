import { registerHooks } from 'node:module';

// Only external I/O seams are replaced; extension factories and lifecycle handlers run unchanged.
export const transportHits = {};
globalThis.__piPerformanceTransportHits = transportHits;
const hit = `const __perfHit = name => { const hits = globalThis.__piPerformanceTransportHits; hits[name] = (hits[name] ?? 0) + 1; };`;
const patches = new Map([
  [
    'pi-browser-use/dist/index.js',
    `
    for (const name of ['connect', 'ensureReady']) DevToolsClient.prototype[name] = async function () { __perfHit('browser.ready'); this.state = 'ready'; };
    DevToolsClient.prototype.listAllTools = async function () { __perfHit('browser.catalog'); return ['list_pages', 'take_snapshot'].map(name => ({name, description: 'Offline fixture', inputSchema: {type: 'object', properties: {}}})); };
    DevToolsClient.prototype.close = async function () { this.state = 'disconnected'; };
  `,
  ],
  [
    'pi-computer-use/dist/mcp-client.js',
    `
    for (const name of ['connect', 'ensureReady']) CuaDriverClient.prototype[name] = async function () { __perfHit('computer.ready'); this.state = 'ready'; };
    CuaDriverClient.prototype.listAllTools = async function () { __perfHit('computer.catalog'); return [{name: 'health_report', description: 'Offline fixture', inputSchema: {type: 'object', properties: {}}}]; };
    CuaDriverClient.prototype.callTool = async function () { __perfHit('computer.probe'); return {content: [], structuredContent: {accessibility: true, screen_recording: true}}; };
    CuaDriverClient.prototype.close = async function () { this.state = 'disconnected'; };
  `,
  ],
  [
    'pi-memory-mem0/dist/provider.js',
    `
    createMem0Provider = async function () { __perfHit('mem0.init'); return {
      ready: Promise.resolve(), supportsSearchCancellation: true, supportsAddCancellation: true, supportsObservationDates: true,
      search: async () => { __perfHit('mem0.search'); return []; },
      add: async () => { __perfHit('mem0.add'); return {results: []}; }, getAll: async () => [], delete: async () => {},
    }; };
  `,
  ],
  [
    'pi-dingtalk/dist/cli.js',
    `
    ensureDws = async () => { __perfHit('dingtalk.ready'); return true; };
    initDws = async () => { __perfHit('dingtalk.init'); };
    getDwsSkillsDir = async () => undefined;
  `,
  ],
  [
    'pi-lark/dist/cli.js',
    `
    ensureLarkCli = async () => { __perfHit('lark.ready'); return true; };
    initLarkCli = async () => { __perfHit('lark.init'); };
    getLarkCliSkillsDir = async () => undefined;
  `,
  ],
  [
    'pi-wecom/dist/cli.js',
    `
    ensureWeComCli = async () => { __perfHit('wecom.ready'); return true; };
    isWeComCliAuthenticated = async () => true;
    getWeComCliSkillsDir = async () => undefined;
  `,
  ],
  [
    'pi-teamwork/dist/adapters/multica.js',
    `
    initMulticaProvider = async config => { __perfHit('teamwork.init'); return {
      adapter: new MulticaAdapter(config, async () => ({code: 0, stdout: '[]', stderr: ''})),
      installResult: {installed: true, alreadyPresent: true},
    }; };
  `,
  ],
  [
    'pi-channels/dist/registry.js',
    `
    ChannelRegistry.prototype.loadAdapter = async function (name) { __perfHit('channels.adapter'); this.register(name, {direction: 'outgoing', send: async () => { __perfHit('channels.send'); }}); };
  `,
  ],
  [
    'pi-telemetry/dist/otel.js',
    `
    import {createRequire as __perfRequire} from 'node:module';
    const {BasicTracerProvider: __PerfProvider, SimpleSpanProcessor: __PerfProcessor} = __perfRequire(import.meta.url)('@opentelemetry/sdk-trace-base');
    createTelemetryExporter = function (config) {
      __perfHit('telemetry.init');
      const sink = {export(spans, callback) { __perfHit('telemetry.export'); callback({code: 0}); }, shutdown: async () => {}, forceFlush: async () => {}};
      return new OtelRuntimeEventExporter({enabled: true, endpoint: '', includePayloads: true, flushAt: 100, flushIntervalMs: 60000}, {provider: new __PerfProvider({spanProcessors: [new __PerfProcessor(sink)]})});
    };
  `,
  ],
]);

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    const patch = [...patches].find(([suffix]) => url.endsWith(`/packages/${suffix}`));
    if (!patch) return loaded;
    if (!loaded.source) throw new Error(`Cannot instrument performance transport: ${patch[0]}`);
    const source =
      typeof loaded.source === 'string'
        ? loaded.source
        : Buffer.from(loaded.source).toString('utf8');
    return { ...loaded, source: `${source}\n${hit}\n${patch[1]}\n` };
  },
});
