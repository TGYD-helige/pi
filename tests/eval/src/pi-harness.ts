/**
 * Shared harness for the agentic L3 evals (browser, computer, …).
 *
 * Instead of hand-rolling a tool-calling loop, we drive the REAL `pi` CLI the
 * same way tests/.github/workflows/integration.yml does:
 *   1. Build an isolated PI_CODING_AGENT_DIR (never touches the user's ~/.pi).
 *   2. GENERATE a models.json in it from parameterized provider/baseUrl/api +
 *      an env-var name for the key (exactly like the CI heredoc) — no hardcoded
 *      endpoint, model, or key, and no copying a machine-specific file.
 *   3. Write the extension settings.json.
 *   4. `pi install ./packages/<ext>` into that dir.
 *   5. Per task: `pi --mode json -p '<task>' --tools <allowlist>` and parse the
 *      JSON event stream (tool_execution_start/end, message_end, agent_end).
 *
 * This runs the extension exactly as shipped (built dist, pi's own dependency
 * resolution), so the eval measures production behavior — no importing package
 * internals under tsx, no duplicated wrapper logic.
 *
 * Nothing here hardcodes a provider, model, endpoint, or key. All come from CLI
 * flags / env: --models <path> (a ready models.json, e.g. one CI wrote from
 * secrets), or --provider / --model / --base-url (or PI_INTEGRATION_BASE_URL) /
 * --api / --api-key-env (default PI_INTEGRATION_API_KEY — the repo-wide
 * convention). See README.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type FailureMode = 'ok' | 'max-steps' | 'tool-error' | 'check-failed' | 'crash';

export interface DriveResult {
  durationMs: number;
  totalTokens?: number;
  toolResults?: Array<{ toolName: string; text: string; isError: boolean }>;
  /** Last assistant message only; intermediate claims are not outcomes. */
  answer: string;
  /** Concatenated tool outputs + names the agent produced (scorer haystack + judge blob). */
  observed: string;
  /**
   * Number of agent turns (turn_start events) taken to reach the answer. Fewer
   * turns = the agent got there in fewer model round-trips — a primary efficiency
   * metric: a better wrapper / prompt should let the model finish in fewer turns.
   */
  turns: number;
  /** Number of tool_execution_end events. */
  toolCalls: number;
  /** Whether any tool result was isError. */
  sawToolError: boolean;
  /** Non-'ok' when the run itself failed (pi crash / non-zero exit). */
  failureMode: FailureMode;
  error?: string;
}

export interface HarnessConfig {
  /** Provider id to pass to `pi --provider` and used as the models.json key. */
  provider: string;
  /** Model id to pass to `pi --model` and register in the generated models.json. */
  model: string;
  /**
   * Local mode: reuse the caller's default pi config (~/.pi/agent) verbatim
   * instead of isolating a temp dir. No models.json is generated, and provider
   * override env vars (ANTHROPIC_ etc.) are still stripped, so pi uses whatever
   * provider the user has authed (e.g. a built-in deepseek via auth.json).
   * --provider/--model still select within it. Use for local runs; CI uses
   * modelsPath.
   */
  useDefaultPi?: boolean;
  /**
   * Path to a ready-made models.json to use verbatim (CI writes one from secrets,
   * same as memory-eval.yml). When set, baseUrl/api/apiKeyEnv are ignored.
   */
  modelsPath?: string;
  /** Provider baseUrl (OpenAI-compatible endpoint). Used only when modelsPath is unset. */
  baseUrl: string;
  /** pi provider `api` shape (default 'openai-responses'). */
  api: string;
  /**
   * Name of the env var that holds the API key. Written verbatim into models.json
   * as the apiKey value so pi resolves it at runtime — the secret never touches
   * disk or logs. Default 'PI_INTEGRATION_API_KEY'. Used only when modelsPath is unset.
   */
  apiKeyEnv: string;
  /** Thinking level (default 'high'; xhigh can hang some gateways). */
  thinking: string;
  /** End-to-end deadline for one Pi invocation, in ms. */
  timeoutMs: number;
  packageRoot?: string;
}

/**
 * models.json contents when generating in-place (no --models given). Mirrors the
 * memory-eval.yml heredoc but keeps the key as an env-var NAME so nothing secret
 * lands on disk. CI paths pass a ready file via modelsPath instead.
 */
function buildModelsJson(hcfg: HarnessConfig): string {
  return JSON.stringify(
    {
      providers: {
        [hcfg.provider]: {
          baseUrl: hcfg.baseUrl,
          api: hcfg.api,
          // Explicit env-var reference; never write the credential into generated config.
          apiKey: `$${hcfg.apiKeyEnv}`,
          authHeader: true,
          models: [{ id: hcfg.model, name: hcfg.model, input: ['text'] }],
        },
      },
    },
    null,
    2,
  );
}

export interface ExtensionSetup {
  /** Package dir name under packages/, e.g. 'pi-browser-use'. */
  pkg?: string;
  /** settings.json contents (the extension's config block(s)). */
  settings: Record<string, unknown>;
  /** Extra packages to also install (e.g. companion extensions). */
  alsoInstall?: string[];
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

export interface Harness {
  cfgDir: string;
  cleanup: () => void;
}

/**
 * Prepare pi for a run. Two modes:
 *   • default (CI): create an isolated PI_CODING_AGENT_DIR, seed models.json +
 *     settings.json, install the extension there. cfgDir is the temp path.
 *   • useDefaultPi (local): reuse the caller's ~/.pi/agent verbatim — no temp
 *     dir, no config writes. cfgDir is '' (runPi then leaves PI_CODING_AGENT_DIR
 *     alone). The extension is still installed (idempotent) so the tool exists.
 * Returns cfgDir (to set as PI_CODING_AGENT_DIR, or '' for default) and cleanup.
 */
export async function setupHarness(hcfg: HarnessConfig, ext: ExtensionSetup): Promise<Harness> {
  if (hcfg.useDefaultPi) {
    // Reuse the user's default pi config. Only ensure the extension is installed.
    const pkgs = [...(ext.pkg ? [ext.pkg] : []), ...(ext.alsoInstall ?? [])];
    for (const p of pkgs) {
      const pkgPath = path.join(hcfg.packageRoot ?? REPO_ROOT, 'packages', p);
      await runPi('', ['install', pkgPath], 120_000);
    }
    return { cfgDir: '', cleanup: () => {} };
  }

  const cfgDir = mkdtempSync(path.join(os.tmpdir(), 'pi-eval-cfg-'));
  const cleanup = () => rmSync(cfgDir, { recursive: true, force: true });
  try {
    mkdirSync(cfgDir, { recursive: true });
    if (hcfg.modelsPath) {
      copyFileSync(hcfg.modelsPath, path.join(cfgDir, 'models.json'));
    } else {
      writeFileSync(path.join(cfgDir, 'models.json'), buildModelsJson(hcfg));
    }
    writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify(ext.settings, null, 2));

    const pkgs = [...(ext.pkg ? [ext.pkg] : []), ...(ext.alsoInstall ?? [])];
    for (const p of pkgs) {
      const pkgPath = path.join(hcfg.packageRoot ?? REPO_ROOT, 'packages', p);
      await runPi(cfgDir, ['install', pkgPath], 120_000);
    }
    return { cfgDir, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

interface PiProcessResult {
  stdout: string;
  code: number;
  error?: string;
}

/** Spawn Pi and retain bounded diagnostics even when the invocation fails. */
function runPi(
  cfgDir: string,
  args: string[],
  timeoutMs: number,
  credentialEnv: readonly string[] = [],
): Promise<PiProcessResult> {
  return new Promise((resolve, reject) => {
    // Strip env vars that would hijack pi's provider selection. Claude Code (and
    // some shells) inject ANTHROPIC_*/OPENAI_* etc.; pi picks those up over its
    // own models.json and then 401s against the wrong endpoint. We want pi to use
    // ONLY the config in our isolated dir. Also strip proxies (mirrors CI).
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) {
      if (
        !credentialEnv.includes(k) &&
        (/^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|DEEPSEEK|GROQ|MISTRAL|XAI|OPENROUTER)_/.test(k) ||
          /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(k))
      ) {
        delete env[k];
      }
    }
    // Isolated mode: pin PI_CODING_AGENT_DIR to our temp dir. Default mode
    // (cfgDir === ''): leave it as-is so pi uses the user's ~/.pi/agent.
    if (cfgDir) {
      env.PI_CODING_AGENT_DIR = cfgDir;
      env.PI_AGENT_HOME = cfgDir;
    }

    // stdin MUST be 'ignore': with an open stdin pipe, pi blocks waiting for
    // interactive input and never streams (0 bytes out). Ignoring it makes pi
    // run headless and flush the --mode json event stream.
    const cwd = cfgDir ? path.join(cfgDir, 'workspace') : REPO_ROOT;
    mkdirSync(cwd, { recursive: true });
    const child = spawn('pi', args, {
      env,
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let pending = '';
    let stderrBytes = 0;
    let failure: string | undefined;
    let bytes = 0;
    const stop = (reason: string) => {
      failure ??= reason;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => stop('Pi exceeded the evaluation deadline'), timeoutMs);
    const keepLine = (line: string) => {
      if (Buffer.byteLength(line) > 2_000_000) {
        stop('Pi event exceeded evaluation limit');
        return;
      }
      let event: { type?: string };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (
        !event ||
        !['session', 'turn_start', 'message_end', 'tool_execution_end'].includes(event.type ?? '')
      )
        return;
      // Bound retained events, not repeated message_update snapshots (as in Skill Eval).
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > 2_000_000) {
        stop('Pi output exceeded evaluation limit');
        return;
      }
      stdout += `${line}\n`;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (failure) return;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        keepLine(line);
        if (failure) {
          pending = '';
          return;
        }
      }
      if (Buffer.byteLength(pending) > 2_000_000) stop('Pi event exceeded evaluation limit');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 2_000_000) stop('Pi diagnostics exceeded evaluation limit');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!failure && pending) keepLine(pending);
      if (args[0] === 'install' && (failure || code !== 0)) {
        reject(new Error(failure ?? `pi install failed (exit ${code})`));
        return;
      }
      resolve({ stdout, code: code ?? 1, ...(failure ? { error: failure } : {}) });
    });
  });
}

interface PiEvent {
  type: string;
  toolName?: string;
  isError?: boolean;
  result?: { content?: Array<{ type: string; text?: string }> };
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }>;
    errorMessage?: string;
    stopReason?: string;
    usage?: { totalTokens?: number };
  };
  errorMessage?: string;
}

function parseEvents(stream: string): PiEvent[] {
  const events: PiEvent[] = [];
  for (const line of stream.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed) as PiEvent);
    } catch {
      // Non-JSON diagnostic line — skip.
    }
  }
  return events;
}

const MAX_OBSERVED = 40_000;
const MAX_ANSWER = 4_000;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[${s.length - max} chars truncated]` : s;
}

/**
 * Run one task prompt through `pi --mode json` and distill the event stream into
 * a DriveResult. `tools` is the comma-separated allowlist passed to --tools.
 */
export async function drivePrompt(
  harness: Harness,
  hcfg: HarnessConfig,
  prompt: string,
  tools: string,
): Promise<DriveResult> {
  const started = Date.now();
  let out: PiProcessResult;
  const credentialEnv = [hcfg.apiKeyEnv];
  if (hcfg.modelsPath) {
    for (const match of readFileSync(hcfg.modelsPath, 'utf8').matchAll(
      /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g,
    ))
      credentialEnv.push(match[1]!);
  }
  try {
    out = await runPi(
      harness.cfgDir,
      [
        '--provider',
        hcfg.provider,
        '--model',
        hcfg.model,
        '--thinking',
        hcfg.thinking,
        '--no-session',
        '--no-context-files',
        '--no-skills',
        '--no-prompt-templates',
        '--no-mcp',
        ...(tools ? ['--tools', tools] : ['--no-tools']),
        '--mode',
        'json',
        '-p',
        prompt,
      ],
      hcfg.timeoutMs,
      credentialEnv,
    );
  } catch {
    return {
      durationMs: Date.now() - started,
      answer: '',
      observed: '',
      turns: 0,
      toolCalls: 0,
      sawToolError: false,
      failureMode: 'crash',
      error: 'Pi did not finish within the execution or output limit.',
    };
  }

  const events = parseEvents(out.stdout);
  // pi can exit 0 while printing a plain-text fatal (e.g. "No API key found
  // for provider X") and emitting ZERO events. Without this, the run reads as
  // a silent check-failed instead of the crash it is.
  if (events.length === 0) {
    return {
      durationMs: Date.now() - started,
      answer: '',
      observed: '',
      turns: 0,
      toolCalls: 0,
      sawToolError: false,
      failureMode: 'crash',
      error: out.error ?? `Pi failed (exit ${out.code}, events ${events.length}).`,
    };
  }
  let answer = '';
  let totalTokens = 0;
  let usageKnown = true;
  let generations = 0;
  const toolResults: NonNullable<DriveResult['toolResults']> = [];
  let traceSize = 0;
  const observedParts: string[] = [];
  let turns = 0;
  let toolCalls = 0;
  let sawToolError = false;
  let providerError: string | undefined;

  for (const ev of events) {
    if (ev.type === 'turn_start') {
      turns++;
    } else if (ev.type === 'tool_execution_end') {
      toolCalls++;
      const text = (ev.result?.content ?? [])
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text as string)
        .join('\n');
      if (ev.isError || text.startsWith('Error:')) sawToolError = true;
      const toolResult = {
        toolName: (ev.toolName ?? 'tool').slice(0, 200),
        text: truncate(text, MAX_OBSERVED / 2),
        isError: Boolean(ev.isError || text.startsWith('Error:')),
      };
      toolResults.push(toolResult);
      traceSize += toolResult.text.length + toolResult.toolName.length + 200;
      while (traceSize > MAX_OBSERVED) {
        const removed = toolResults.shift()!;
        traceSize -= removed.text.length + removed.toolName.length + 200;
      }
      observedParts.push(`# ${ev.toolName ?? 'tool'}${ev.isError ? ' [error]' : ''}\n${text}`);
    } else if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
      const text = (ev.message.content ?? [])
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text as string)
        .join('\n');
      answer = text;
      generations++;
      const tokens = ev.message.usage?.totalTokens;
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0)
        totalTokens += tokens;
      else usageKnown = false;
      if (ev.message.errorMessage || ['error', 'aborted'].includes(ev.message.stopReason ?? ''))
        providerError = 'Provider failed or generation aborted.';
    }
  }

  const error =
    out.error ??
    (out.code !== 0
      ? `Pi failed (exit ${out.code}).`
      : (providerError ?? (!answer ? 'Pi produced no final answer.' : undefined)));

  return {
    durationMs: Date.now() - started,
    ...(usageKnown && generations ? { totalTokens } : {}),
    toolResults,
    answer: error ? '' : truncate(answer, MAX_ANSWER),
    observed: truncate(observedParts.join('\n'), MAX_OBSERVED),
    turns,
    toolCalls,
    sawToolError,
    failureMode: error ? 'crash' : 'ok',
    ...(error ? { error } : {}),
  };
}

// ─── Shared arg parsing + provider resolution ────────────────────────────────

export interface CommonArgs {
  provider: string;
  model: string;
  useDefaultPi: boolean;
  modelsPath: string;
  baseUrl: string;
  api: string;
  apiKeyEnv: string;
  thinking: string;
  timeoutMs: number;
  taskId: string;
  tasks: number;
  trials: number;
  output: string;
  packageRoot: string;
}

/**
 * Parse the flags shared by every pi-CLI eval. Provider-config modes:
 *   • --use-default-pi: reuse ~/.pi/agent verbatim (local; uses whatever provider
 *     you've authed, e.g. a built-in deepseek). provider/model still select.
 *   • --models <path>: use a ready-made models.json verbatim (CI writes one from
 *     secrets, same as memory-eval.yml).
 *   • otherwise: generate models.json from --base-url (or PI_INTEGRATION_BASE_URL)
 *     + the env var named by --api-key-env (default PI_INTEGRATION_API_KEY).
 * Env fallbacks use the repo-wide PI_INTEGRATION_* convention. Nothing is
 * hardcoded to a machine.
 */
export function parseCommonArgs(defaults: { model: string; timeoutMs: number }): CommonArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string, dflt: string) => {
    const i = argv.indexOf(flag);
    if (i < 0) return dflt;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };
  const tasks = Number(get('--tasks', '0'));
  const timeoutMs = Number(get('--timeout', String(defaults.timeoutMs)));
  if (!Number.isInteger(tasks) || tasks < 0)
    throw new Error('--tasks must be a nonnegative integer');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout must be positive');
  const trials = Number(get('--trials', '3'));
  if (!Number.isInteger(trials) || trials < 1 || trials > 20)
    throw new Error('--trials must be an integer from 1 to 20');
  return {
    trials,
    output: get('--output', ''),
    packageRoot: path.resolve(get('--package-root', REPO_ROOT)),
    provider: get('--provider', process.env.PI_EVAL_PROVIDER || 'deepseek-integration'),
    model: get('--model', process.env.PI_EVAL_MODEL || defaults.model),
    useDefaultPi: argv.includes('--use-default-pi'),
    modelsPath: get('--models', process.env.PI_MODELS_PATH || ''),
    baseUrl: get('--base-url', process.env.PI_INTEGRATION_BASE_URL || ''),
    api: get('--api', process.env.PI_EVAL_API || 'openai-responses'),
    apiKeyEnv: get('--api-key-env', process.env.PI_EVAL_API_KEY_ENV || 'PI_INTEGRATION_API_KEY'),
    thinking: get('--thinking', 'high'),
    timeoutMs,
    taskId: get('--task', ''),
    tasks,
  };
}

/**
 * Convert parsed args → HarnessConfig. --use-default-pi reuses ~/.pi/agent;
 * --models trusts the file; otherwise we require --base-url + the key env var so
 * the generated models.json is usable.
 */
export function toHarnessConfig(args: CommonArgs): HarnessConfig {
  const base = {
    packageRoot: args.packageRoot,
    provider: args.provider,
    model: args.model,
    api: args.api,
    apiKeyEnv: args.apiKeyEnv,
    thinking: args.thinking,
    timeoutMs: args.timeoutMs,
  };
  if (args.useDefaultPi) {
    return { ...base, useDefaultPi: true, baseUrl: args.baseUrl };
  }
  if (args.modelsPath) {
    return { ...base, modelsPath: args.modelsPath, baseUrl: args.baseUrl };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(args.apiKeyEnv))
    throw new Error('--api-key-env must name an environment variable');
  if (!args.baseUrl) {
    throw new Error(
      'No provider config. Pass --use-default-pi (reuse ~/.pi/agent), --models <models.json>, ' +
        'or --base-url <url> (or set PI_INTEGRATION_BASE_URL) to generate one.',
    );
  }
  if (!process.env[args.apiKeyEnv]) {
    throw new Error(
      `API key env var "${args.apiKeyEnv}" is not set. Export it (or pass --api-key-env <NAME>).`,
    );
  }
  return { ...base, baseUrl: args.baseUrl };
}
