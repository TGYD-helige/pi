import { constants, readdirSync, readFileSync } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export type PiSettingsOptions = {
  /** Stop asynchronous reads between native filesystem operations. */
  signal?: AbortSignal;
  cwd?: string;
  /** Override for the config directory. If not set, resolveConfigDir() is used. */
  configDir?: string;
  /** Whether project-local settings and policies may be read. Defaults to false. */
  projectTrusted?: boolean;
  /** Whether to expand bare $ENV_VAR references in global and agent-dir settings. Defaults to true. */
  expandBareEnvVars?: boolean;
  /** Refuse malformed/unreadable trusted project settings instead of ignoring them. */
  strictProjectSettings?: boolean;
};

export function isProjectTrusted(
  context: { isProjectTrusted?: () => boolean } | null | undefined,
): boolean {
  return context?.isProjectTrusted?.() === true;
}

function resolveEnvVars(value: unknown, expandBareEnvVars: boolean): unknown {
  if (typeof value === 'string') {
    const pattern = expandBareEnvVars ? /\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g : /\$\{([^}]+)\}/g;
    return value.replace(
      pattern,
      (_match, braced: string | undefined, bare: string | undefined) => {
        const expr = braced ?? bare ?? '';
        const [name, ...rest] = expr.split(':-');
        const fallback = rest.join(':-');
        const envVal = process.env[name!];
        if (envVal !== undefined && envVal !== '') return envVal;
        return fallback;
      },
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvVars(item, expandBareEnvVars));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = resolveEnvVars(v, expandBareEnvVars);
    }
    return result;
  }
  return value;
}

function readSettingsSection<T>(
  filePath: string,
  key: string,
  options: { expandEnv: boolean; expandBareEnvVars: boolean; strict?: boolean },
): Partial<T> {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const section = parsed[key] ?? {};
      if (!section || typeof section !== 'object' || Array.isArray(section)) {
        if (options.strict) throw new Error('project settings section must be an object');
        return {};
      }
      return (
        options.expandEnv ? resolveEnvVars(section, options.expandBareEnvVars) : section
      ) as Partial<T>;
    }
    if (options.strict) throw new Error('project settings root must be an object');
    return {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (options.strict) {
      throw new Error('Trusted project settings are unreadable or malformed.', { cause: error });
    }
    return {};
  }
}

/**
 * Resolve the user data / runtime home directory.
 * Used for: memories, data, skills, logs.
 */
export function resolveHome(override?: string): string {
  return resolve(override ?? process.env.PI_AGENT_HOME ?? join(homedir(), '.pi', 'agent'));
}

/**
 * Resolve the system config directory.
 * Used for: settings.json, policy, auth, models.
 */
export function resolveConfigDir(override?: string): string {
  return resolve(
    override ??
      process.env.PI_CODING_AGENT_DIR ??
      process.env.PI_AGENT_HOME ??
      join(homedir(), '.pi', 'agent'),
  );
}

/** @deprecated Use resolveHome() or resolveConfigDir() instead. */
export function resolveAgentDir(override?: string): string {
  return resolveHome(override);
}

/**
 * Load extension config from pi-agent settings files.
 * Reads from global (~/.pi/agent/settings.json), agentDir (env/param), and trusted project
 * (<cwd>/.pi/settings.json) settings.
 * Priority from low to high: global < agentDir < project.
 * Environment variables are expanded only in the global and agentDir layers.
 */
export function loadPiSettings<T>(key: string, options?: PiSettingsOptions): T {
  const globalDir = resolve(join(homedir(), '.pi', 'agent'));
  const configDir = resolveConfigDir(options?.configDir);
  const cwd = options?.cwd ?? process.cwd();

  const globalSettings = readSettingsSection<T>(join(globalDir, 'settings.json'), key, {
    expandEnv: true,
    expandBareEnvVars: options?.expandBareEnvVars !== false,
  });

  const configSettings =
    configDir === globalDir
      ? ({} as Partial<T>)
      : readSettingsSection<T>(join(configDir, 'settings.json'), key, {
          expandEnv: true,
          expandBareEnvVars: options?.expandBareEnvVars !== false,
        });

  const projectSettings =
    options?.projectTrusted === true
      ? readSettingsSection<T>(join(cwd, '.pi', 'settings.json'), key, {
          expandEnv: false,
          expandBareEnvVars: false,
          strict: options?.strictProjectSettings === true,
        })
      : ({} as Partial<T>);

  return { ...globalSettings, ...configSettings, ...projectSettings } as T;
}

export function loadJsonProfileDir<T>(dir: string): Record<string, T> {
  const result: Record<string, T> = {};
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const name = basename(entry, '.json');
    try {
      const raw = readFileSync(join(dir, entry), 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        result[name] = parsed as T;
      }
    } catch {
      // skip malformed files
    }
  }
  return result;
}

function configurationLayers(options?: PiSettingsOptions) {
  const global = resolve(join(homedir(), '.pi', 'agent'));
  const config = resolveConfigDir(options?.configDir);
  return [
    { dir: global, project: false },
    ...(config === global ? [] : [{ dir: config, project: false }]),
    ...(options?.projectTrusted === true
      ? [{ dir: resolve(join(options.cwd ?? process.cwd(), '.pi')), project: true }]
      : []),
  ];
}

export function loadPiPolicyProfiles<T>(options?: PiSettingsOptions): Record<string, T> {
  let result: Record<string, T> = {};
  for (const { dir } of configurationLayers(options))
    result = { ...result, ...loadJsonProfileDir<T>(join(dir, 'policy')) };
  return result;
}

const MAX_CONFIG_FILE_BYTES = 128 * 1024;
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;
const MAX_POLICY_BYTES = 2 * 1024 * 1024;
const MAX_POLICY_FILES = 128;
const MAX_POLICY_ENTRIES = 1024;

async function readBoundedConfig(path: string, maxBytes: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    signal?.throwIfAborted();
    const metadata = await handle.stat();
    signal?.throwIfAborted();
    if (!metadata.isFile() || metadata.size > maxBytes)
      throw new Error('Configuration file size limit exceeded.');
    const buffer = Buffer.alloc(metadata.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      signal?.throwIfAborted();
      const result = await handle.read(buffer, bytes, buffer.length - bytes, null);
      signal?.throwIfAborted();
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > metadata.size)
      throw new Error('Configuration file changed while reading; size limit cannot be verified.');
    return { parsed: JSON.parse(buffer.subarray(0, bytes).toString('utf8')), bytes };
  } finally {
    await handle.close();
  }
}

/** Fresh, bounded settings for authorization; malformed configuration rejects the decision. */
export async function loadPiSettingsAsync<T>(key: string, options?: PiSettingsOptions): Promise<T> {
  let result = {};
  for (const { dir, project } of configurationLayers(options)) {
    options?.signal?.throwIfAborted();
    try {
      const { parsed } = await readBoundedConfig(
        join(dir, 'settings.json'),
        MAX_SETTINGS_FILE_BYTES,
        options?.signal,
      );
      options?.signal?.throwIfAborted();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Settings root must be an object.');
      const section = parsed[key] ?? {};
      if (!section || typeof section !== 'object' || Array.isArray(section))
        throw new Error('Settings section must be an object.');
      result = {
        ...result,
        ...(project
          ? section
          : (resolveEnvVars(section, options?.expandBareEnvVars !== false) as object)),
      };
    } catch (error) {
      options?.signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  options?.signal?.throwIfAborted();
  return result as T;
}

/** Read fresh policies with bounded directory traversal and allocation; failures must block authorization. */
export async function loadPiPolicyProfilesAsync<T>(
  options?: PiSettingsOptions,
): Promise<Record<string, T>> {
  const result: Record<string, T> = {};
  let entries = 0;
  let files = 0;
  let bytes = 0;
  for (const { dir } of configurationLayers(options)) {
    options?.signal?.throwIfAborted();
    let directory: Awaited<ReturnType<typeof opendir>>;
    try {
      directory = await opendir(join(dir, 'policy'));
    } catch (error) {
      options?.signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (options?.signal?.aborted) {
      await directory.close();
      options.signal.throwIfAborted();
    }
    for await (const entry of directory) {
      options?.signal?.throwIfAborted();
      if (++entries > MAX_POLICY_ENTRIES) throw new Error('Policy directory entry limit exceeded.');
      if (!entry.name.endsWith('.json')) continue;
      if (++files > MAX_POLICY_FILES) throw new Error('Policy file count limit exceeded.');
      const value = await readBoundedConfig(
        join(dir, 'policy', entry.name),
        Math.min(MAX_CONFIG_FILE_BYTES, MAX_POLICY_BYTES - bytes),
        options?.signal,
      );
      options?.signal?.throwIfAborted();
      bytes += value.bytes;
      if (!value.parsed || typeof value.parsed !== 'object' || Array.isArray(value.parsed))
        throw new Error('Policy profile must be an object.');
      result[basename(entry.name, '.json')] = value.parsed;
    }
  }
  options?.signal?.throwIfAborted();
  return result;
}
