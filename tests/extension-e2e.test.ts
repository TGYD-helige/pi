import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createJiti } from 'jiti/static';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PACKAGES_DIR = path.join(ROOT, 'packages');

const EXTENSION_PACKAGES = [
  'pi-attachments',
  'pi-browser-use',
  'pi-channels',
  'pi-computer-use',
  'pi-dingtalk',
  'pi-image-gen',
  'pi-lark',
  'pi-memory',
  'pi-memory-mem0',
  'pi-security',
  'pi-task-scheduler',
  'pi-teamwork',
  'pi-telemetry',
  'pi-web-access',
  'pi-wecom',
] as const;

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
): Promise<{ factory: Function; ext: CollectedExtension }> {
  const packageDir = path.join(PACKAGES_DIR, pkgName);
  const packageJson = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const extensionEntry = packageJson.pi.extensions[0]
    .replace('./dist/', './src/')
    .replace(/\.js$/, '.ts');
  const entryPath = path.join(packageDir, extensionEntry);
  const jiti = createJiti(entryPath, { moduleCache: false });
  const factory = (await jiti.import(entryPath, { default: true })) as Function;
  const { api, ext } = createCollector();
  await factory(api);
  return { factory, ext };
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

// Packages whose src/index.ts is a circular-import target: index.ts re-exports the extension
// factory (`export { default } from './extension.js'`) while sibling modules import runtime
// values back from index.ts. A static/bundling loader (jiti here, and Pi's own extension
// loader) evaluates the entry before the cycle resolves, so the re-exported default comes back
// `undefined`. The fix is to move the shared runtime values out of index.ts into a leaf module,
// so nothing imports values back from the entry (pi-telemetry was fixed this way).
// pi-task-scheduler still has this shape and is tracked separately.
const JITI_FACTORY_INVOKE_SKIP = new Set([
  'pi-task-scheduler',
]);

describe('Extension E2E loading via jiti', () => {
  for (const pkgName of EXTENSION_PACKAGES) {
    it(`${pkgName}: package.json declares pi.extensions`, () => {
      const pkgJson = JSON.parse(
        readFileSync(path.join(PACKAGES_DIR, pkgName, 'package.json'), 'utf8'),
      );
      expect(pkgJson.pi?.extensions).toBeInstanceOf(Array);
      expect(pkgJson.pi.extensions.length).toBeGreaterThan(0);
    });

    if (JITI_FACTORY_INVOKE_SKIP.has(pkgName)) continue;

    it(`${pkgName}: jiti loads default factory and invokes it without throwing`, async () => {
      const { factory, ext } = await loadExtensionWithJiti(pkgName);
      expect(typeof factory).toBe('function');
      // At minimum, every Pi extension hooks at least one event or registers
      // at least one tool/command. A factory that does nothing is almost
      // certainly broken.
      const totalRegistrations =
        ext.handlers.size + ext.tools.size + ext.commands.size;
      expect(totalRegistrations).toBeGreaterThan(0);
    });
  }

  it('pi-computer-use: loads via jiti and registers session handlers', async () => {
    const { ext } = await loadExtensionWithJiti('pi-computer-use');
    expect(ext.handlers.has('session_start')).toBe(true);
    expect(ext.handlers.has('session_shutdown')).toBe(true);
  });

  it('pi-browser-use: loads via jiti and registers session handlers', async () => {
    const { ext } = await loadExtensionWithJiti('pi-browser-use');
    expect(ext.handlers.has('session_start')).toBe(true);
    expect(ext.handlers.has('session_shutdown')).toBe(true);
  });

  it('pi-channels: registers /channel command and notify tool', async () => {
    const { ext } = await loadExtensionWithJiti('pi-channels');
    expect(ext.commands.has('channel')).toBe(true);
    expect(ext.tools.has('notify')).toBe(true);
  });

  it('pi-image-gen: registers /image-gen command, and image_generate tool after session_start', async () => {
    const { ext } = await loadExtensionWithJiti('pi-image-gen');
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
    const { ext } = await loadExtensionWithJiti('pi-memory');
    expect(ext.commands.has('memory')).toBe(true);
  });

  it('pi-teamwork: registers /teamwork-status command at top level', async () => {
    const { ext } = await loadExtensionWithJiti('pi-teamwork');
    expect(ext.commands.has('teamwork-status')).toBe(true);
  });

  // pi-task-scheduler is skipped above: its src/index.ts is a circular-import target
  // (siblings import runtime values back from the entry that re-exports the factory), so a
  // static loader returns `undefined` for the default. Its command registrations are covered by
  // the vitest-native-loader path in tests/extension-loading.test.ts. See JITI_FACTORY_INVOKE_SKIP.
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
