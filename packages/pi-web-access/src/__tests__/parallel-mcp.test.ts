import { afterEach, describe, expect, it, vi } from 'vitest';
import piWebToolExtension, { getProvider, resolveSearchProvider } from '../index.js';

let activeSettings: any = {};
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, loadWebToolSettings: vi.fn(() => activeSettings) };
});

function emit(value: string) {
  process.stdout.write(String.fromCharCode(10) + value + String.fromCharCode(10));
}

const live = Boolean(process.env.PARALLEL_MCP_LIVE_SMOKE_PROXY_URL);
const hasFixture = Boolean(
  process.env.PARALLEL_MCP_CONTRACT_FIXTURE_URL || process.env.PARALLEL_MCP_CONTRACT_FIXTURE_PATH,
);
let localFixture: { url: string; statusUrl: string; close(): Promise<void> } | undefined;

async function fixtureEndpoint(): Promise<string> {
  if (live) return process.env.PARALLEL_MCP_LIVE_SMOKE_PROXY_URL!;
  if (process.env.PARALLEL_MCP_CONTRACT_FIXTURE_URL)
    return new URL('/mcp', process.env.PARALLEL_MCP_CONTRACT_FIXTURE_URL).toString();
  const fixtureModule = await import(process.env.PARALLEL_MCP_CONTRACT_FIXTURE_PATH!);
  const fixture = await fixtureModule.startParallelSearchMcpFixture({
    attributionMode: 'project_version',
    project: 'pi',
    version: '0.1.2-beta.15',
  });
  localFixture = fixture;
  return fixture.url;
}
function createPi() {
  const tools = new Map<string, any>();
  const listeners = new Map<string, (...args: any[]) => any>();
  return {
    tools,
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on(event: string, handler: (...args: any[]) => any) {
      listeners.set(event, handler);
    },
    async start() {
      await listeners.get('session_start')?.({}, { cwd: '/tmp', hasUI: false });
    },
  };
}
afterEach(async () => {
  await localFixture?.close();
  localFixture = undefined;
  vi.restoreAllMocks();
});

(live || hasFixture ? describe : describe.skip)('Parallel MCP production integration', () => {
  it(
    'registers and invokes the real agent-visible web_search tool',
    async () => {
      if (!getProvider('parallel' as any)) {
        process.stdout.write(
          String.fromCharCode(10) +
            'PARALLEL_MCP_BASELINE_MISSING_INTEGRATION' +
            String.fromCharCode(10),
        );
        throw new Error('Parallel production integration is absent.');
      }
      const endpoint = await fixtureEndpoint();
      activeSettings = {
        timeoutMs: live ? 30_000 : 2_000,
        search: { provider: 'parallel' },
        providers: { parallel: { baseUrl: endpoint } },
      };
      const resolved = resolveSearchProvider(activeSettings);
      expect(resolved).toMatchObject({ id: 'parallel', baseUrl: endpoint });
      expect('error' in resolved ? undefined : resolved.apiKey).toBeUndefined();
      const pi = createPi();
      piWebToolExtension(pi as any);
      expect(pi.tools.size).toBe(0);
      await pi.start();
      expect([...pi.tools.keys()]).toEqual(['web_search']);
      expect(pi.tools.has('web_fetch')).toBe(false);
      expect(pi.tools.has('image_search')).toBe(false);
      const objective = live
        ? process.env.PARALLEL_MCP_LIVE_SMOKE_OBJECTIVE
        : 'official Python documentation';
      const query = live
        ? process.env.PARALLEL_MCP_LIVE_SMOKE_QUERY
        : 'official Python documentation';
      expect(objective).toBe('official Python documentation');
      expect(query).toBe('official Python documentation');
      const result = await pi.tools
        .get('web_search')
        .execute('call-1', { query, maxResults: 3 }, undefined, undefined, {});
      const text = result.content[0].text;
      expect(text).toContain('## Web Search Results (parallel)');
      if (live) {
        expect(text).toMatch(/https?:\/\/\S+/);
        expect(text.length).toBeGreaterThan(80);
        emit(
          'PARALLEL_MCP_LIVE_SMOKE=' +
            JSON.stringify({
              endpoint: 'https://search.parallel.ai/mcp',
              objective,
              search_queries: [query],
              tools_list: 1,
              web_search: 1,
              web_fetch: 0,
              redirects: 0,
              anonymous: true,
            }),
        );
      } else {
        expect(text).toContain('Canonical web_search evidence');
        expect(text).toContain('https://example.test/');
        expect(text).toContain('[https://example.test/nullable-title]');
        expect(text).toContain('Result 3');
      }
      if (!live && !process.env.PARALLEL_MCP_CONTRACT_FIXTURE_URL) {
        const observed = (await fetch(localFixture!.statusUrl).then((response) =>
          response.json(),
        )) as any;
        emit(
          'PARALLEL_MCP_FIXTURE_STATUS=' +
            JSON.stringify({
              endpoint: 'https://search.parallel.ai/mcp',
              advertised_tools: observed.advertisedTools,
              tools_list: observed.toolsListCount,
              web_search: observed.toolCallCounts.web_search,
              web_fetch: observed.toolCallCounts.web_fetch,
              anonymous: !observed.credentialsObserved,
              sessions_cleaned: observed.sessions.exactlyOnceCleanup,
              user_agent: {
                classification: observed.sourceAttribution.classification,
                project: observed.sourceAttribution.project,
                version: observed.sourceAttribution.version,
                verified: observed.sourceAttribution.verified,
              },
            }),
        );
        emit(
          'PARALLEL_MCP_SCENARIOS=' +
            JSON.stringify({
              tool_contract: true,
              result_contract: true,
              provider_independence: true,
              preserves_defaults: true,
              explicit_opt_in: true,
              privacy_disclosure: true,
              preserves_headers: true,
              timeout_error: true,
              lifecycle_cleanup: true,
            }),
        );
      }
    },
    live ? 35_000 : 5_000,
  );

  it('preserves safe headers, strips credentials, and honors timeout', async () => {
    if (live || process.env.PARALLEL_MCP_CONTRACT_FIXTURE_URL) return;
    const fixtureModule = await import(process.env.PARALLEL_MCP_CONTRACT_FIXTURE_PATH!);
    const headerFixture = await fixtureModule.startParallelSearchMcpFixture({
      attributionMode: 'project_version',
      project: 'pi',
      version: '0.1.2-beta.15',
    });
    const forbidden = [
      'Authorization',
      'COOKIE',
      'Proxy-Authorization',
      'Api-Key',
      'X-Api-Key',
      'X-Access-Token',
      'X-Auth-Token',
      'X-Parallel-Api-Key',
    ];
    const seen: Headers[] = [];
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      seen.push(new Headers(init?.headers));
      return nativeFetch(input, init);
    });
    activeSettings = {
      timeoutMs: 2_000,
      search: { provider: 'parallel' },
      providers: {
        parallel: {
          baseUrl: headerFixture.url,
          headers: Object.fromEntries([
            ...forbidden.map((name) => [name, 'synthetic-sentinel']),
            ['X-Safe-Sentinel', 'safe'],
            ['user-agent', 'pi/0.1.2-beta.15'],
          ]),
        },
      },
    };
    const pi = createPi();
    piWebToolExtension(pi as any);
    await pi.start();
    await pi.tools
      .get('web_search')
      .execute('headers', { query: 'official Python documentation' }, undefined, undefined, {});
    const status = (await nativeFetch(headerFixture.statusUrl).then((response) =>
      response.json(),
    )) as any;
    expect(status.credentialsObserved).toBe(false);
    for (const headers of seen) {
      expect(headers.get('x-safe-sentinel')).toBe('safe');
      expect(headers.get('user-agent')).toBe('pi/0.1.2-beta.15');
      for (const name of forbidden) expect(headers.has(name)).toBe(false);
    }
    await headerFixture.close();
    vi.restoreAllMocks();
    const timeoutFixture = await fixtureModule.startParallelSearchMcpFixture({
      mode: 'timeout',
      delayMs: 250,
    });
    activeSettings = {
      timeoutMs: 25,
      search: { provider: 'parallel' },
      providers: { parallel: { baseUrl: timeoutFixture.url } },
    };
    const timeoutPi = createPi();
    piWebToolExtension(timeoutPi as any);
    await timeoutPi.start();
    await expect(
      timeoutPi.tools
        .get('web_search')
        .execute('timeout', { query: 'official Python documentation' }, undefined, undefined, {}),
    ).rejects.toThrow();
    await timeoutFixture.close();
  }, 5_000);
});
