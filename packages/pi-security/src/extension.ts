import type {
  JsonObject,
  JsonValue,
  RuntimeRequestContext,
  ToolCallRequest,
  ToolSource,
} from '@amaster.ai/pi-shared';
import { isProjectTrusted, loadPiSettings } from '@amaster.ai/pi-shared/settings';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  UserBashEvent,
  UserBashEventResult,
} from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  canonicalizeSecurityPath,
  type SecurityAuditEvent,
  type SecurityConfig,
  type SecurityDecision,
  type SecurityEvaluationResult,
  SecurityGate,
  securityEvaluationDetails,
} from './index.js';
import { loadFilePoliciesAsync } from './policy-loader.js';

const SETTINGS_KEY = 'pi-security';
const EXTENSION_STATUS_KEY = 'pi-security';
const DEFAULT_PROFILE = 'auto-review';
const DEFAULT_AUDIT_LIMIT = 200;
const PATH_ARGUMENT_KEYS = new Set([
  'path',
  'paths',
  'file',
  'files',
  'source',
  'destination',
  'target',
  'file_path',
  'file_paths',
  'cwd',
  'output_dir',
  'directory',
  'directories',
  'image',
  'images',
  'image_path',
  'firstFrame',
  'lastFrame',
  'referenceImages',
]);
const CAMEL_CASE_PATH_ARGUMENT_KEY = /(?:Path|Paths|Dir|Directory|Directories)$/;

export type PiSecurityExtensionConfig = {
  enabled?: boolean;
  profile?: string;
  security?: SecurityConfig;
  auditLimit?: number;
  approvals?: {
    allowSessionGrants?: boolean;
  };
};

export type PiSecuritySessionGrant = {
  signature: string;
};

export type PiSecurityExtensionState = {
  config: ResolvedPiSecurityExtensionConfig;
  auditLog: SecurityAuditEvent[];
  grants: PiSecuritySessionGrant[];
};

export type ResolvedPiSecurityExtensionConfig = {
  enabled: boolean;
  profile: string;
  security?: SecurityConfig;
  auditLimit: number;
  allowSessionGrants: boolean;
};

export default function piSecurityExtension(pi: ExtensionAPI): void {
  const state: PiSecurityExtensionState = {
    config: resolvePiSecurityConfig(),
    auditLog: [],
    grants: [],
  };

  pi.on('session_start', async (_event, ctx) => {
    state.config = resolvePiSecurityConfig(loadSettings(ctx.cwd, isProjectTrusted(ctx)));
    state.auditLog = [];
    state.grants = [];
    ctx.ui.setStatus(
      EXTENSION_STATUS_KEY,
      state.config.enabled ? `security: ${state.config.profile}` : 'security: disabled',
    );
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    ctx.ui.setStatus(EXTENSION_STATUS_KEY, undefined);
    state.auditLog = [];
    state.grants = [];
  });

  pi.on('tool_call', async (event, ctx) => authorizePiToolCall(event, ctx, state));
  pi.on('user_bash', async (event, ctx) => authorizeUserBash(event, ctx, state));

  pi.registerCommand('pi-security-status', {
    description: 'Show Pi security policy status.',
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatSecurityStatus(state), 'info');
    },
  });

  pi.registerCommand('pi-security-audit', {
    description: 'Show recent Pi security authorization decisions.',
    handler: async (args, ctx) => {
      ctx.ui.notify(formatAuditLog(state, parseAuditLimit(args)), 'info');
    },
  });

  pi.registerCommand('pi-security-reset', {
    description: 'Clear in-session Pi security approval grants.',
    handler: async (_args, ctx) => {
      state.grants = [];
      ctx.ui.notify('Pi security session grants cleared.', 'info');
    },
  });
}

export async function authorizePiToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  state: PiSecurityExtensionState,
): Promise<ToolCallEventResult | undefined> {
  if (!state.config.enabled) {
    return undefined;
  }
  const toolCall = toolCallFromPiEvent(event);
  const evaluation = await (await createGate(ctx, state)).authorize({
    request: requestFromContext(ctx),
    toolCall,
    workspaceDir: ctx.cwd,
  });
  if (evaluation.decision.kind === 'deny' || evaluation.decision.kind === 'ask') {
    return { block: true, reason: evaluation.decision.reason };
  }
  return undefined;
}

export async function authorizeUserBash(
  event: UserBashEvent,
  ctx: ExtensionContext,
  state: PiSecurityExtensionState,
): Promise<UserBashEventResult | undefined> {
  if (!state.config.enabled) {
    return undefined;
  }
  const toolCall: ToolCallRequest = {
    id: 'user-bash',
    name: 'bash',
    source: 'builtin',
    args: {
      command: event.command,
      cwd: event.cwd,
      excludeFromContext: event.excludeFromContext,
    },
  };
  const evaluation = await (await createGate(ctx, state)).authorize({
    request: requestFromContext(ctx),
    toolCall,
    workspaceDir: ctx.cwd,
  });
  if (evaluation.decision.kind === 'deny' || evaluation.decision.kind === 'ask') {
    return {
      result: {
        output: evaluation.decision.reason,
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  }
  return undefined;
}

export function resolvePiSecurityConfig(
  config?: PiSecurityExtensionConfig,
): ResolvedPiSecurityExtensionConfig {
  const configuredAuditLimit = config?.auditLimit;
  const auditLimit =
    Number.isInteger(configuredAuditLimit) &&
    configuredAuditLimit !== undefined &&
    configuredAuditLimit > 0
      ? Math.min(configuredAuditLimit, 1_000)
      : DEFAULT_AUDIT_LIMIT;
  return {
    enabled: config?.enabled !== false,
    profile: config?.profile?.trim() || DEFAULT_PROFILE,
    ...(config?.security ? { security: config.security } : {}),
    auditLimit,
    allowSessionGrants: config?.approvals?.allowSessionGrants !== false,
  };
}

async function createGate(
  ctx: ExtensionContext,
  state: PiSecurityExtensionState,
): Promise<SecurityGate> {
  const projectTrusted = isProjectTrusted(ctx);
  const options = { cwd: ctx.cwd, configDir: getAgentDir(), projectTrusted };
  let filePolicies = await loadFilePoliciesAsync(options);
  if (projectTrusted && !isProjectTrusted(ctx)) {
    filePolicies = await loadFilePoliciesAsync({ ...options, projectTrusted: false });
  }
  return new SecurityGate({
    profile: state.config.profile,
    ...(state.config.security ? { config: state.config.security } : {}),
    filePolicies,
    approvalHandler: async ({ toolCall, decision, evaluation }) =>
      resolveApproval(ctx, state, toolCall, decision, evaluation),
    auditSink: (event) => {
      state.auditLog.push(event);
      if (state.auditLog.length > state.config.auditLimit) {
        state.auditLog.splice(0, state.auditLog.length - state.config.auditLimit);
      }
    },
  });
}

async function resolveApproval(
  ctx: ExtensionContext,
  state: PiSecurityExtensionState,
  toolCall: ToolCallRequest,
  decision: Extract<SecurityDecision, { kind: 'ask' }>,
  evaluation: SecurityEvaluationResult,
): Promise<SecurityDecision> {
  if (hasSessionGrant(ctx, state, toolCall, decision, evaluation)) {
    return { kind: 'allow', reason: `Allowed by in-session grant: ${decision.reason}` };
  }
  if (!ctx.hasUI) {
    return decision;
  }

  if (!state.config.allowSessionGrants) {
    const approved = await ctx.ui.confirm(
      decision.prompt ?? 'Approve tool call?',
      approvalMessage(toolCall, decision),
    );
    return approved
      ? { kind: 'allow', reason: `Approved by user: ${decision.reason}` }
      : denyByUser(decision);
  }

  const choice = await ctx.ui.select(
    `${decision.prompt ?? 'Approve tool call?'}\n${approvalMessage(toolCall, decision)}`,
    ['Allow once', 'Allow similar for this session', 'Deny'],
  );
  if (choice === 'Allow once') {
    return { kind: 'allow', reason: `Approved by user: ${decision.reason}` };
  }
  if (choice === 'Allow similar for this session') {
    state.grants.push({ signature: grantSignature(ctx, toolCall, decision, evaluation) });
    return { kind: 'allow', reason: `Approved by user with session grant: ${decision.reason}` };
  }
  return denyByUser(decision);
}

function loadSettings(cwd: string, projectTrusted = false): PiSecurityExtensionConfig | undefined {
  try {
    const config = loadPiSettings<Partial<PiSecurityExtensionConfig>>(SETTINGS_KEY, {
      cwd,
      projectTrusted,
    });
    return Object.keys(config).length > 0 ? (config as PiSecurityExtensionConfig) : undefined;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requestFromContext(ctx: ExtensionContext): RuntimeRequestContext {
  const sessionId = ctx.sessionManager.getSessionId();
  const model = ctx.model;
  return {
    sessionId,
    conversationId: sessionId,
    trigger: 'user',
    senderTrust: 'owner',
    interactive: ctx.hasUI,
    model: {
      provider: stringFromRecord(model, 'provider') ?? 'pi',
      model: stringFromRecord(model, 'id') ?? stringFromRecord(model, 'name') ?? 'unknown',
    },
  };
}

function toolCallFromPiEvent(event: ToolCallEvent): ToolCallRequest {
  return {
    id: event.toolCallId,
    name: event.toolName,
    source: toolSourceForPiTool(event.toolName),
    args: normalizeToolArgs(event.toolName, event.input),
  };
}

function toolSourceForPiTool(toolName: string): ToolSource {
  if (toolName.startsWith('mcp_') || toolName.startsWith('mcp__')) {
    return 'mcp';
  }
  if (['bash', 'write', 'edit', 'read', 'ls', 'grep', 'find'].includes(toolName)) {
    return 'builtin';
  }
  return 'runtime';
}

function normalizeToolArgs(toolName: string, input: Record<string, unknown>): JsonObject {
  const args = toJsonObject(input);
  if (toolName === 'bash' && typeof input.command === 'string') {
    return { ...args, command: input.command };
  }
  return args;
}

function toJsonObject(input: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    const jsonValue = toJsonValue(value);
    if (jsonValue !== undefined) {
      result[key] = jsonValue;
    }
  }
  return result;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue).filter((item): item is JsonValue => item !== undefined);
  }
  if (isPlainObject(value)) {
    return toJsonObject(value);
  }
  return undefined;
}

function hasSessionGrant(
  ctx: ExtensionContext,
  state: PiSecurityExtensionState,
  toolCall: ToolCallRequest,
  decision: Extract<SecurityDecision, { kind: 'ask' }>,
  evaluation: SecurityEvaluationResult,
): boolean {
  const signature = grantSignature(ctx, toolCall, decision, evaluation);
  return state.grants.some((grant) => grant.signature === signature);
}

function grantSignature(
  ctx: ExtensionContext,
  toolCall: ToolCallRequest,
  decision: Extract<SecurityDecision, { kind: 'ask' }>,
  evaluation: SecurityEvaluationResult,
): string {
  const normalize = (value: JsonValue, key?: string): JsonValue => {
    if (
      typeof value === 'string' &&
      (PATH_ARGUMENT_KEYS.has(key ?? '') || CAMEL_CASE_PATH_ARGUMENT_KEY.test(key ?? ''))
    ) {
      return canonicalizeSecurityPath(ctx.cwd, value);
    }
    if (Array.isArray(value)) return value.map((item) => normalize(item, key));
    if (value && typeof value === 'object') {
      const sorted: JsonObject = {};
      for (const childKey of Object.keys(value).sort()) {
        const child = value[childKey];
        if (child !== undefined) sorted[childKey] = normalize(child, childKey);
      }
      return sorted;
    }
    return value;
  };
  return JSON.stringify({
    tool: toolCall.name,
    source: toolCall.source,
    args: normalize(toolCall.args),
    resources: evaluation.resources.map((resource) => ({
      ...resource,
      ...(resource.kind === 'file' && resource.target
        ? { target: canonicalizeSecurityPath(ctx.cwd, resource.target) }
        : {}),
    })),
    risk: {
      level: evaluation.risk.level,
      reasons: [...evaluation.risk.reasons].sort(),
    },
    matchedRules: [...evaluation.matchedRuleIds].sort(),
    decision: {
      reason: decision.reason,
      ...(decision.prompt ? { prompt: decision.prompt } : {}),
    },
  });
}

function denyByUser(decision: Extract<SecurityDecision, { kind: 'ask' }>): SecurityDecision {
  return { kind: 'deny', reason: `User denied approval: ${decision.reason}` };
}

function approvalMessage(
  toolCall: ToolCallRequest,
  decision: Extract<SecurityDecision, { kind: 'ask' }>,
): string {
  const target = summarizeToolCall(toolCall);
  return target ? `${decision.reason}\n\n${target}` : decision.reason;
}

function summarizeToolCall(toolCall: ToolCallRequest): string {
  const command = stringArg(toolCall.args, 'command');
  if (command) {
    return command;
  }
  const filePath = stringArg(toolCall.args, 'path') ?? stringArg(toolCall.args, 'file_path');
  if (filePath) {
    return filePath;
  }
  return toolCall.name;
}

function formatSecurityStatus(state: PiSecurityExtensionState): string {
  return [
    `Pi security: ${state.config.enabled ? 'enabled' : 'disabled'}`,
    `Profile: ${state.config.profile}`,
    `Audit entries: ${state.auditLog.length}`,
    `Session grants: ${state.grants.length}`,
  ].join('\n');
}

function formatAuditLog(state: PiSecurityExtensionState, limit: number): string {
  if (state.auditLog.length === 0) {
    return 'Pi security audit log is empty.';
  }
  return state.auditLog
    .slice(-limit)
    .map((event) => {
      const details = securityEvaluationDetails(event);
      return `${event.createdAt} ${event.toolName} -> ${event.decision.kind} (${details.risk})`;
    })
    .join('\n');
}

function parseAuditLimit(args: string | undefined): number {
  const parsed = Number.parseInt((args ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 50) : 10;
}

function stringArg(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function stringFromRecord(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const actual = (value as Record<string, unknown>)[key];
  return typeof actual === 'string' ? actual : undefined;
}
