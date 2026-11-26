import { createJiti } from 'jiti/static';
import { describe, expect, it } from 'vitest';
import { extensionPackageNames, extensionSourcePaths } from './fixtures/extension-packages.js';

interface CollectedExtension {
  handlers: Map<string, unknown[]>;
  tools: Map<string, { name: string; parameters: unknown; [k: string]: unknown }>;
  commands: Map<string, unknown>;
}

function createCollector(): { api: Record<string, unknown>; ext: CollectedExtension } {
  const ext: CollectedExtension = {
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
  };
  const api = {
    on(event: string, handler: unknown) {
      ext.handlers.set(event, [...(ext.handlers.get(event) || []), handler]);
    },
    registerTool(tool: { name: string; parameters: unknown }) {
      ext.tools.set(tool.name, tool as CollectedExtension['tools'] extends Map<string, infer V> ? V : never);
    },
    registerCommand(name: string, opts: unknown) {
      ext.commands.set(name, opts);
    },
    registerProvider() {},
    unregisterProvider() {},
    registerShortcut() {},
    registerFlag() {},
    appendEntry() {},
    exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    sendUserMessage() {},
    getActiveTools: () => [],
    setActiveTools() {},
    events: { emit() {}, on() {} },
  };
  return { api, ext };
}

async function loadExtensionWithJiti(
  pkgName: string,
  entryPath = extensionSourcePaths(pkgName)[0],
): Promise<CollectedExtension> {
  const jiti = createJiti(entryPath, { moduleCache: false });
  const factory = await jiti.import<(api: Record<string, unknown>) => void | Promise<void>>(
    entryPath,
    { default: true },
  );
  expect(typeof factory, entryPath).toBe('function');
  const { api, ext } = createCollector();
  await factory(api);
  return ext;
}

function findSchemaViolations(schema: unknown, path = ''): string[] {
  const violations: string[] = [];
  if (!schema || typeof schema !== 'object') return violations;
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.items)) {
    violations.push(`${path}.items is an array (tuple schema) — incompatible with Moonshot/Kimi`);
  }
  if (s.items && typeof s.items === 'object' && !Array.isArray(s.items)) {
    violations.push(...findSchemaViolations(s.items, `${path}.items`));
  }
  if (s.properties && typeof s.properties === 'object') {
    for (const [key, val] of Object.entries(s.properties as Record<string, unknown>)) {
      violations.push(...findSchemaViolations(val, `${path}.${key}`));
    }
  }
  if (s.additionalProperties && typeof s.additionalProperties === 'object') {
    violations.push(...findSchemaViolations(s.additionalProperties, `${path}.additionalProperties`));
  }
  return violations;
}

// A cold Jiti import of the Feishu SDK can exceed Vitest's default timeout on CI.
const CHANNELS_JITI_TIMEOUT_MS = 15_000;

describe('Extension E2E loading via jiti', () => {
  for (const pkgName of extensionPackageNames) {
    const timeout = pkgName === 'pi-channels' ? CHANNELS_JITI_TIMEOUT_MS : undefined;
    it(`${pkgName}: jiti loads and invokes each declared factory`, async () => {
      for (const entryPath of extensionSourcePaths(pkgName)) {
        const ext = await loadExtensionWithJiti(pkgName, entryPath);
        const totalRegistrations = ext.handlers.size + ext.tools.size + ext.commands.size;
        expect(totalRegistrations, entryPath).toBeGreaterThan(0);
      }
    }, timeout);
  }

  it('pi-computer-use: loads via jiti and registers session handlers', async () => {
    const ext = await loadExtensionWithJiti('pi-computer-use');
    expect(ext.handlers.has('session_start')).toBe(true);
    expect(ext.handlers.has('session_shutdown')).toBe(true);
  });

  it('pi-browser-use: loads via jiti and registers session handlers', async () => {
    const ext = await loadExtensionWithJiti('pi-browser-use');
    expect(ext.handlers.has('session_start')).toBe(true);
    expect(ext.handlers.has('session_shutdown')).toBe(true);
  });

  it('pi-channels: registers /channel command and notify tool', async () => {
    const ext = await loadExtensionWithJiti('pi-channels');
    expect(ext.commands.has('channel')).toBe(true);
    expect(ext.tools.has('notify')).toBe(true);
  }, CHANNELS_JITI_TIMEOUT_MS);

  it('pi-image-gen: registers /image-gen command, and image_generate tool after session_start', async () => {
    const ext = await loadExtensionWithJiti('pi-image-gen');
    expect(ext.commands.has('image-gen')).toBe(true);
    // The tool registers inside session_start: its schema is shaped for the
    // provider resolved from just-loaded settings (e.g. quality is exposed only
    // for OpenAI/OpenRouter), so it can't be built at factory time.
    const handler = ext.handlers.get('session_start')?.[0] as (
      event: unknown,
      ctx: unknown,
    ) => Promise<void>;
    expect(handler).toBeDefined();
    await handler({}, { cwd: process.cwd() });
    expect(ext.tools.has('image_generate')).toBe(true);
  });

  it('pi-memory: registers /memory command at top level', async () => {
    const ext = await loadExtensionWithJiti('pi-memory');
    expect(ext.commands.has('memory')).toBe(true);
  });

  it('pi-teamwork: registers /teamwork-status command at top level', async () => {
    const ext = await loadExtensionWithJiti('pi-teamwork');
    expect(ext.commands.has('teamwork-status')).toBe(true);
  });
});

describe('findSchemaViolations regression', () => {
  it('detects tuple-style items (array of schemas)', () => {
    const tupleSchema = {
      type: 'object',
      properties: {
        action: {
          type: 'object',
          properties: {
            path: {
              type: 'array',
              items: {
                type: 'array',
                items: [{ type: 'number' }, { type: 'number' }],
              },
            },
          },
        },
      },
    };
    const violations = findSchemaViolations(tupleSchema);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain('tuple');
  });

  it('passes for valid array-style items (object schema)', () => {
    const arraySchema = {
      type: 'object',
      properties: {
        action: {
          type: 'object',
          properties: {
            path: {
              type: 'array',
              items: {
                type: 'array',
                items: { type: 'number' },
                minItems: 2,
                maxItems: 2,
              },
            },
          },
        },
      },
    };
    const violations = findSchemaViolations(arraySchema);
    expect(violations).toEqual([]);
  });
});
