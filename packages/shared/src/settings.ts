import { readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export type PiSettingsOptions = {
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

export function loadPiPolicyProfiles<T>(options?: PiSettingsOptions): Record<string, T> {
  const globalDir = resolve(join(homedir(), '.pi', 'agent', 'policy'));
  const configPolicyDir = resolve(join(resolveConfigDir(options?.configDir), 'policy'));
  const projectDir = resolve(join(options?.cwd ?? process.cwd(), '.pi', 'policy'));

  const globalPolicies = loadJsonProfileDir<T>(globalDir);
  const configPolicies =
    configPolicyDir === globalDir
      ? ({} as Record<string, T>)
      : loadJsonProfileDir<T>(configPolicyDir);
  const projectPolicies =
    options?.projectTrusted === true
      ? loadJsonProfileDir<T>(projectDir)
      : ({} as Record<string, T>);

  return { ...globalPolicies, ...configPolicies, ...projectPolicies };
}

/** Read current policies without blocking the event loop or caching revoked rules. */
export async function loadPiPolicyProfilesAsync<T>(
  options?: PiSettingsOptions,
): Promise<Record<string, T>> {
  const globalDir = resolve(join(homedir(), '.pi', 'agent', 'policy'));
  const configDir = resolve(join(resolveConfigDir(options?.configDir), 'policy'));
  const dirs = [
    globalDir,
    ...(configDir === globalDir ? [] : [configDir]),
    ...(options?.projectTrusted === true
      ? [resolve(join(options.cwd ?? process.cwd(), '.pi', 'policy'))]
      : []),
  ];
  const result: Record<string, T> = {};
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        console.error('[pi-shared] unable to read policy directory');
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await readFile(join(dir, entry), 'utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          result[basename(entry, '.json')] = parsed;
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
          console.error('[pi-shared] unable to read policy profile');
      }
    }
  }
  return result;
}
