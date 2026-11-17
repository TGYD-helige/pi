import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type {
  JsonObject,
  RuntimeRequestContext,
  ToolCallRequest,
  ToolSource,
} from '@amaster.ai/pi-shared';

export type SecurityDecision =
  | { kind: 'allow'; reason?: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string; prompt?: string };

export type CapabilityPolicy = {
  allow?: string[];
  deny?: string[];
};

export type SandboxMode = 'read-only' | 'workspace-write' | 'full-access';
export type ApprovalMode = 'never' | 'on-failure' | 'on-request' | 'untrusted';

export type SecurityResourceKind = 'file' | 'shell' | 'network';
export type SecurityOperation = 'read' | 'write' | 'execute' | 'delete' | 'connect' | 'search';
export type SecurityScope = 'workspace' | 'home' | 'system' | 'external' | 'unknown';
export type SecuritySensitivity = 'normal' | 'source' | 'config' | 'secret' | 'credential';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type SecurityResource = {
  kind: SecurityResourceKind;
  operation: SecurityOperation;
  target?: string;
  scope: SecurityScope;
  sensitivity: SecuritySensitivity;
};

export type RiskAssessment = {
  level: RiskLevel;
  reasons: string[];
};

export type SecurityRule = {
  id: string;
  priority?: number;
  tools?: string[];
  sources?: ToolSource[];
  triggers?: Array<RuntimeRequestContext['trigger']>;
  senderTrusts?: Array<RuntimeRequestContext['senderTrust']>;
  args?: Record<string, string>;
  argsRegex?: Record<string, string>;
  resources?: SecurityResourceKind[];
  operations?: SecurityOperation[];
  scopes?: SecurityScope[];
  sensitivity?: SecuritySensitivity[];
  risk?: RiskLevel[];
  decision: SecurityDecision;
};

export type SecurityPolicyEngineOptions = {
  rules?: SecurityRule[];
  defaultDecision?: SecurityDecision;
};

export type SecurityProfileConfig = {
  extends?: string;
  sandbox?: SandboxMode;
  approval?: ApprovalMode;
  rules?: SecurityRule[];
  defaultDecision?: SecurityDecision;
};

export type SecurityConfig = {
  defaultProfile?: string;
  profiles?: Record<string, SecurityProfileConfig>;
};

export type SecurityEvaluationContext = {
  request: RuntimeRequestContext;
  toolCall: ToolCallRequest;
  workspaceDir?: string;
  resources: SecurityResource[];
  risk: RiskAssessment;
};

export type SecurityEvaluationResult = {
  evaluationId: string;
  decision: SecurityDecision;
  resources: SecurityResource[];
  risk: RiskAssessment;
  matchedRuleIds: string[];
};

export type SecurityAuditEvent = SecurityEvaluationResult & {
  sessionId: string;
  conversationId: string;
  traceId?: string;
  toolCallId: string;
  toolName: string;
  createdAt: string;
  approvalId?: string;
};

export type SecurityApprovalRequest = {
  request: RuntimeRequestContext;
  toolCall: ToolCallRequest;
  decision: Extract<SecurityDecision, { kind: 'ask' }>;
  evaluation: SecurityEvaluationResult;
};

export type SecurityApprovalHandler = (input: SecurityApprovalRequest) => Promise<SecurityDecision>;
export type SecurityAuditSink = (event: SecurityAuditEvent) => void | Promise<void>;

export type SecurityGateAuthorizeInput = {
  request: RuntimeRequestContext;
  toolCall: ToolCallRequest;
  workspaceDir?: string;
};

export type SecurityGateOptions = {
  profile: string;
  config?: SecurityConfig;
  filePolicies?: Record<string, SecurityProfileConfig>;
  engine?: SecurityPolicyEngine;
  approvalHandler?: SecurityApprovalHandler;
  auditSink?: SecurityAuditSink;
};

const DEFAULT_DECISION: SecurityDecision = {
  kind: 'ask',
  reason: 'No security rule matched this tool call.',
};

const SANDBOX_CAPABILITIES: Record<SandboxMode, CapabilityPolicy> = {
  'read-only': {
    allow: ['read', 'ls', 'find', 'grep'],
    deny: ['write', 'edit', 'bash'],
  },
  'workspace-write': {
    allow: ['read', 'ls', 'find', 'grep', 'write', 'edit', 'bash'],
    deny: [],
  },
  'full-access': { allow: ['*'] },
};

const BUILTIN_PROFILES: Record<string, { sandbox: SandboxMode; approval: ApprovalMode }> = {
  'read-only': { sandbox: 'read-only', approval: 'never' },
  default: { sandbox: 'workspace-write', approval: 'on-request' },
  auto: { sandbox: 'workspace-write', approval: 'on-failure' },
  'full-access': { sandbox: 'full-access', approval: 'never' },
};

const DEFAULT_BUILTIN_PROFILE = BUILTIN_PROFILES.default as {
  sandbox: SandboxMode;
  approval: ApprovalMode;
};

const DENY_SECRETS_RULE: SecurityRule = {
  id: 'deny-secrets',
  priority: 600,
  sensitivity: ['secret', 'credential'],
  decision: { kind: 'deny', reason: 'Secret or credential resources are protected.' },
};

const BASELINE_SECURITY_RULES: SecurityRule[] = [DENY_SECRETS_RULE];

const ASK_WORKSPACE_WRITE_RULE: SecurityRule = {
  id: 'ask-workspace-write',
  priority: 260,
  resources: ['file'],
  operations: ['write', 'delete'],
  scopes: ['workspace'],
  decision: {
    kind: 'ask',
    reason: 'Workspace file modifications require approval.',
    prompt: 'Approve this file modification?',
  },
};

const ASK_HIGH_RISK_RULES: SecurityRule[] = [
  {
    id: 'ask-critical-risk',
    priority: 500,
    risk: ['critical'],
    decision: { kind: 'ask', reason: 'Critical risk operation requires approval.' },
  },
  {
    id: 'ask-high-risk',
    priority: 420,
    risk: ['high'],
    decision: { kind: 'ask', reason: 'High risk operation requires approval.' },
  },
];

function builtinRulesForApproval(approval: ApprovalMode): SecurityRule[] {
  switch (approval) {
    case 'never':
      return [...BASELINE_SECURITY_RULES];
    case 'on-failure':
      return [...BASELINE_SECURITY_RULES, ...ASK_HIGH_RISK_RULES];
    case 'on-request':
      return [...BASELINE_SECURITY_RULES, ...ASK_HIGH_RISK_RULES, ASK_WORKSPACE_WRITE_RULE];
    case 'untrusted':
      return [...BASELINE_SECURITY_RULES, ...ASK_HIGH_RISK_RULES, ASK_WORKSPACE_WRITE_RULE];
  }
}

function defaultDecisionForApproval(approval: ApprovalMode): SecurityDecision {
  if (approval === 'untrusted') {
    return { kind: 'ask', reason: 'Untrusted profile requires approval for unknown tool calls.' };
  }
  return { kind: 'allow' };
}

export class SecurityPolicyEngine {
  private readonly entries: SecurityRule[];
  private readonly defaultDecision: SecurityDecision;

  constructor(options: SecurityPolicyEngineOptions = {}) {
    this.entries = [...(options.rules ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    this.defaultDecision = options.defaultDecision ?? DEFAULT_DECISION;
  }

  decide(input: {
    request: RuntimeRequestContext;
    toolCall: ToolCallRequest;
    workspaceDir?: string;
  }): SecurityDecision {
    return this.evaluate(input).decision;
  }

  evaluate(input: {
    request: RuntimeRequestContext;
    toolCall: ToolCallRequest;
    workspaceDir?: string;
  }): SecurityEvaluationResult {
    const resources = classifySecurityResources(input);
    const risk = assessRisk({ ...input, resources });
    const context: SecurityEvaluationContext = { ...input, resources, risk };
    const matchedRuleIds: string[] = [];
    for (const entry of this.entries) {
      if (matchesSecurityRule(entry, context)) {
        matchedRuleIds.push(entry.id);
        return {
          evaluationId: randomUUID(),
          decision: normalizeForInteraction(entry.decision, input.request.interactive),
          resources,
          risk,
          matchedRuleIds,
        };
      }
    }
    return {
      evaluationId: randomUUID(),
      decision: normalizeForInteraction(this.defaultDecision, input.request.interactive),
      resources,
      risk,
      matchedRuleIds,
    };
  }
}

export class SecurityGate {
  private readonly engine: SecurityPolicyEngine;
  private readonly approvalHandler: SecurityApprovalHandler | undefined;
  private readonly auditSink: SecurityAuditSink | undefined;

  constructor(options: SecurityGateOptions) {
    this.engine =
      options.engine ??
      createSecurityPolicyEngineForProfile(options.profile, options.config, options.filePolicies);
    this.approvalHandler = options.approvalHandler;
    this.auditSink = options.auditSink;
  }

  async authorize(input: SecurityGateAuthorizeInput): Promise<SecurityEvaluationResult> {
    const initial = this.engine.evaluate(input);
    const decision = await this.resolveDecision(input, initial);
    const evaluation = { ...initial, decision };
    await this.audit(input, evaluation);
    return evaluation;
  }

  private async resolveDecision(
    input: SecurityGateAuthorizeInput,
    evaluation: SecurityEvaluationResult,
  ): Promise<SecurityDecision> {
    if (evaluation.decision.kind !== 'ask') {
      return evaluation.decision;
    }
    if (!this.approvalHandler) {
      return evaluation.decision;
    }
    const resolved = await this.approvalHandler({
      request: input.request,
      toolCall: input.toolCall,
      decision: evaluation.decision,
      evaluation,
    });
    return resolved;
  }

  private async audit(
    input: SecurityGateAuthorizeInput,
    evaluation: SecurityEvaluationResult,
  ): Promise<void> {
    if (!this.auditSink) {
      return;
    }
    await this.auditSink({
      ...evaluation,
      sessionId: input.request.sessionId,
      conversationId: input.request.conversationId,
      ...(input.request.traceId ? { traceId: input.request.traceId } : {}),
      toolCallId: input.toolCall.id,
      toolName: input.toolCall.name,
      createdAt: new Date().toISOString(),
    });
  }
}

export function createSecurityGate(options: SecurityGateOptions): SecurityGate {
  return new SecurityGate(options);
}

export async function assertSecurityAllowed(input: {
  request: RuntimeRequestContext;
  securityGate: SecurityGate;
  toolCall: ToolCallRequest;
  workspaceDir?: string;
}): Promise<SecurityEvaluationResult> {
  const evaluation = await input.securityGate.authorize({
    request: input.request,
    toolCall: input.toolCall,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  assertSecurityDecisionAllowed(evaluation.decision);
  return evaluation;
}

export function assertSecurityDecisionAllowed(decision: SecurityDecision): void {
  switch (decision.kind) {
    case 'allow':
      return;
    case 'ask':
      throw new Error(`Tool call requires approval: ${decision.reason}`);
    case 'deny':
      throw new Error(`Tool call denied by security policy: ${decision.reason}`);
  }
}

export function resolveCapabilityPolicy(
  profile: string,
  config: SecurityConfig = {},
  filePolicies: Record<string, SecurityProfileConfig> = {},
): CapabilityPolicy {
  return resolveSecurityProfile(profile, config, [], filePolicies).capabilities;
}

export function isCapabilityExposed(toolName: string, policy: CapabilityPolicy): boolean {
  const normalized = normalizePatternValue(toolName);
  if (policy.deny?.some((entry) => matchesPattern(normalized, entry))) {
    return false;
  }
  if (!policy.allow?.length) {
    return false;
  }
  return policy.allow.some((entry) => matchesPattern(normalized, entry));
}

export function createSecurityPolicyEngineForProfile(
  profile: string,
  config: SecurityConfig = {},
  filePolicies: Record<string, SecurityProfileConfig> = {},
): SecurityPolicyEngine {
  const resolvedProfile = resolveSecurityProfile(profile, config, [], filePolicies);
  const denyCapabilityRules: SecurityRule[] =
    resolvedProfile.capabilities.deny?.map((toolName) => ({
      id: `deny-capability-${profile}-${toolName}`,
      priority: 550,
      tools: [toolName],
      decision: {
        kind: 'deny',
        reason: `Tool '${toolName}' is denied by sandbox '${resolvedProfile.sandbox}'.`,
      },
    })) ?? [];
  const allowCapabilityRules: SecurityRule[] =
    resolvedProfile.capabilities.allow?.map((toolName) => ({
      id: `allow-capability-${profile}-${toolName}`,
      priority: 100,
      tools: [toolName],
      decision: { kind: 'allow' },
    })) ?? [];
  return new SecurityPolicyEngine({
    rules: resolvedProfile.rules.concat(denyCapabilityRules).concat(allowCapabilityRules),
    defaultDecision:
      resolvedProfile.defaultDecision ?? defaultDecisionForApproval(resolvedProfile.approval),
  });
}

export function classifySecurityResources(input: {
  request: RuntimeRequestContext;
  toolCall: ToolCallRequest;
  workspaceDir?: string;
}): SecurityResource[] {
  const { toolCall } = input;
  if (toolCall.name === 'read') {
    return [fileResource('read', stringArg(toolCall.args, 'path'), input.workspaceDir)];
  }
  if (toolCall.name === 'ls') {
    return [fileResource('read', stringArg(toolCall.args, 'path'), input.workspaceDir)];
  }
  if (toolCall.name === 'find' || toolCall.name === 'grep') {
    return [
      fileResource(
        'search',
        stringArg(toolCall.args, 'path') ?? stringArg(toolCall.args, 'cwd'),
        input.workspaceDir,
      ),
    ];
  }
  if (toolCall.name === 'write' || toolCall.name === 'edit') {
    return [fileResource('write', stringArg(toolCall.args, 'path'), input.workspaceDir)];
  }
  if (toolCall.name === 'bash') {
    const command = stringArg(toolCall.args, 'command') ?? toolCall.name;
    const resources: SecurityResource[] = [
      {
        kind: 'shell',
        operation: 'execute',
        target: command,
        scope: fileScope(stringArg(toolCall.args, 'cwd'), input.workspaceDir),
        sensitivity: 'normal',
      },
    ];
    if (/https?:\/\/|(^|\s)(curl|wget|ssh|scp|rsync)\b/i.test(command)) {
      resources.push({
        kind: 'network',
        operation: 'connect',
        target: command,
        scope: 'external',
        sensitivity: 'normal',
      });
    }
    resources.push(
      ...shellFileResources(
        command,
        stringArg(toolCall.args, 'cwd') ?? input.workspaceDir,
        input.workspaceDir,
      ),
    );
    return resources;
  }
  return [
    {
      kind: 'shell',
      operation: 'execute',
      target: toolCall.name,
      scope: 'unknown',
      sensitivity: 'normal',
    },
  ];
}

export function assessRisk(input: {
  toolCall: ToolCallRequest;
  resources: SecurityResource[];
}): RiskAssessment {
  const reasons: string[] = [];
  let level: RiskLevel = 'low';
  const raise = (next: RiskLevel, reason: string) => {
    if (riskRank(next) > riskRank(level)) {
      level = next;
    }
    reasons.push(reason);
  };
  for (const resource of input.resources) {
    if (resource.sensitivity === 'secret' || resource.sensitivity === 'credential') {
      raise('critical', `Sensitive ${resource.sensitivity} resource`);
    }
    if (resource.kind === 'file' && resource.operation === 'write') {
      raise(
        resource.scope === 'workspace' ? 'medium' : 'high',
        `File write in ${resource.scope} scope`,
      );
    }
    if (resource.kind === 'shell') {
      raise('medium', 'Shell/code execution');
      const command = resource.target ?? '';
      if (/\brm\s+-rf\b|:\(\)\s*\{|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b/i.test(command)) {
        raise('critical', 'Destructive shell command');
      }
      if (/\bsudo\b|\bchmod\b|\bchown\b|\bkill(all)?\b|\blaunchctl\b/i.test(command)) {
        raise('high', 'Privileged or permission-changing shell command');
      }
      if (
        /\b(npm|pnpm|yarn|pip|brew|apt|apt-get)\s+(install|add|upgrade|update)\b/i.test(command)
      ) {
        raise('high', 'Dependency or package manager mutation');
      }
      if (/curl\b.*\|\s*(sh|bash)|wget\b.*\|\s*(sh|bash)/i.test(command)) {
        raise('critical', 'Remote script execution');
      }
    }
    if (resource.kind === 'network') {
      raise('high', 'External network access');
    }
  }
  return {
    level,
    reasons: reasons.length ? [...new Set(reasons)] : ['Low risk read-only operation'],
  };
}

export function securityEvaluationDetails(evaluation: SecurityEvaluationResult): JsonObject {
  return {
    decision: evaluation.decision.kind,
    risk: evaluation.risk.level,
    riskReasons: evaluation.risk.reasons,
    matchedRules: evaluation.matchedRuleIds,
    resources: evaluation.resources.map((resource) => ({
      kind: resource.kind,
      operation: resource.operation,
      scope: resource.scope,
      sensitivity: resource.sensitivity,
      ...(resource.target ? { target: summarizeTarget(resource.target) } : {}),
    })),
  };
}

type ResolvedProfile = {
  sandbox: SandboxMode;
  approval: ApprovalMode;
  capabilities: CapabilityPolicy;
  rules: SecurityRule[];
  defaultDecision?: SecurityDecision;
};

function resolvedFromBuiltin(name: string): ResolvedProfile {
  const builtin = BUILTIN_PROFILES[name] ?? DEFAULT_BUILTIN_PROFILE;
  return {
    sandbox: builtin.sandbox,
    approval: builtin.approval,
    capabilities: SANDBOX_CAPABILITIES[builtin.sandbox],
    rules: builtinRulesForApproval(builtin.approval),
  };
}

function resolveSecurityProfile(
  profile: string,
  config: SecurityConfig,
  seen: string[] = [],
  filePolicies: Record<string, SecurityProfileConfig> = {},
): ResolvedProfile {
  const normalizedProfile = profile.trim();
  if (seen.includes(normalizedProfile)) {
    return resolvedFromBuiltin('default');
  }
  const configured = filePolicies[normalizedProfile] ?? config.profiles?.[normalizedProfile];
  const parent: ResolvedProfile = configured?.extends
    ? resolveSecurityProfile(
        configured.extends,
        config,
        seen.concat(normalizedProfile),
        filePolicies,
      )
    : resolvedFromBuiltin(normalizedProfile);
  if (!configured) {
    return parent;
  }
  const sandbox = configured.sandbox ?? parent.sandbox;
  const approval = configured.approval ?? parent.approval;
  const sandboxChanged = configured.sandbox !== undefined && configured.sandbox !== parent.sandbox;
  const approvalChanged =
    configured.approval !== undefined && configured.approval !== parent.approval;
  const inheritedDefault = configured.defaultDecision ?? parent.defaultDecision;
  return {
    sandbox,
    approval,
    capabilities: sandboxChanged ? SANDBOX_CAPABILITIES[sandbox] : parent.capabilities,
    rules: (approvalChanged ? builtinRulesForApproval(approval) : parent.rules).concat(
      normalizeConfiguredRules(configured.rules),
    ),
    ...(inheritedDefault ? { defaultDecision: inheritedDefault } : {}),
  };
}

function normalizeConfiguredRules(rules: SecurityRule[] | undefined): SecurityRule[] {
  return (rules ?? []).map((rule) => ({
    ...rule,
    priority: rule.priority ?? 300,
  }));
}

function matchesSecurityRule(rule: SecurityRule, context: SecurityEvaluationContext): boolean {
  if (
    rule.tools?.length &&
    !rule.tools.some((tool) => matchesPattern(context.toolCall.name, tool))
  ) {
    return false;
  }
  if (rule.sources?.length && !rule.sources.includes(context.toolCall.source)) {
    return false;
  }
  if (rule.triggers?.length && !rule.triggers.includes(context.request.trigger)) {
    return false;
  }
  if (rule.senderTrusts?.length && !rule.senderTrusts.includes(context.request.senderTrust)) {
    return false;
  }
  if (rule.args && !matchesArgs(rule.args, context.toolCall.args)) {
    return false;
  }
  if (rule.argsRegex && !matchesArgsRegex(rule.argsRegex, context.toolCall.args)) {
    return false;
  }
  if (rule.risk?.length && !rule.risk.includes(context.risk.level)) {
    return false;
  }
  if (
    hasResourceCriteria(rule) &&
    !context.resources.some((resource) => matchesResourceCriteria(rule, resource))
  ) {
    return false;
  }
  return true;
}

function hasResourceCriteria(rule: SecurityRule): boolean {
  return Boolean(
    rule.resources?.length ||
      rule.operations?.length ||
      rule.scopes?.length ||
      rule.sensitivity?.length,
  );
}

function matchesResourceCriteria(rule: SecurityRule, resource: SecurityResource): boolean {
  if (rule.resources?.length && !rule.resources.includes(resource.kind)) {
    return false;
  }
  if (rule.operations?.length && !rule.operations.includes(resource.operation)) {
    return false;
  }
  if (rule.scopes?.length && !rule.scopes.includes(resource.scope)) {
    return false;
  }
  if (rule.sensitivity?.length && !rule.sensitivity.includes(resource.sensitivity)) {
    return false;
  }
  return true;
}

function normalizeForInteraction(
  decision: SecurityDecision,
  interactive: boolean,
): SecurityDecision {
  if (decision.kind === 'ask' && !interactive) {
    return {
      kind: 'deny',
      reason: `Security policy requires approval but the context is non-interactive: ${decision.reason}`,
    };
  }
  return decision;
}

function fileResource(
  operation: SecurityOperation,
  value: string | undefined,
  workspaceDir: string | undefined,
): SecurityResource {
  const canonical = value ? canonicalizeSecurityPath(workspaceDir, value) : undefined;
  return {
    kind: 'file',
    operation,
    ...(value ? { target: value } : {}),
    scope: fileScope(value, workspaceDir),
    sensitivity: classifyPathSensitivity(canonical),
  };
}

function fileScope(value: string | undefined, workspaceDir: string | undefined): SecurityScope {
  if (!value) {
    return 'unknown';
  }
  return canonicalFileScope(canonicalizeSecurityPath(workspaceDir, value), workspaceDir);
}

function canonicalFileScope(normalized: string, workspaceDir: string | undefined): SecurityScope {
  if (workspaceDir && pathInside(normalized, canonicalizeSecurityPath(undefined, workspaceDir))) {
    return 'workspace';
  }
  const home = process.env.HOME;
  if (home && pathInside(normalized, canonicalizeSecurityPath(undefined, home))) {
    return 'home';
  }
  return 'system';
}

const SHELL_WRITE_COMMANDS = new Set([
  'cp',
  'dd',
  'install',
  'ln',
  'mkdir',
  'mv',
  'rm',
  'rmdir',
  'shred',
  'tee',
  'touch',
  'truncate',
  'unlink',
]);

const SHELL_COPY_COMMANDS = new Set(['cp', 'ln', 'mv']);
const SHELL_DELETE_COMMANDS = new Set(['rm', 'rmdir', 'shred', 'unlink']);
const SHELL_REDIRECT_TOKEN = /^\d*>>?$/;
const SHELL_REDIRECT_PREFIX = /^\d*>>?/;
const SHELL_GLOB_CHAR = /[*?[{]/;
const SHELL_LOGIN_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const SHELL_SENSITIVE_NAMES =
  /^(credential|credentials|password|passwords|token|tokens|secret|secrets)$/;
const SHELL_SENSITIVE_FILES = /^(id_rsa|id_ed25519|\.npmrc|\.pypirc)$/;
const SHELL_WRAPPERS = new Set([
  'command',
  'doas',
  'env',
  'exec',
  'nice',
  'nohup',
  'sudo',
  'time',
  'xargs',
]);

type ShellPathCandidate = { value: string; index: number; redirect: boolean };

// Shell commands are opaque to the file classifiers above, so a secret path
// passed to `bash` would otherwise skip the baseline `deny-secrets` rule.
function shellFileResources(
  command: string,
  baseDir: string | undefined,
  workspaceDir: string | undefined,
): SecurityResource[] {
  const tokens = splitShellCommand(command);
  const candidates = shellPathCandidates(tokens);
  const verb = shellVerb(tokens);
  const copyTargetIndex = SHELL_COPY_COMMANDS.has(verb) ? shellCopyTargetIndex(tokens) : undefined;
  const seen = new Set<string>();
  const resources: SecurityResource[] = [];
  for (const candidate of candidates) {
    const target = expandShellHome(candidate.value);
    const normalized = canonicalizeSecurityPath(baseDir, target);
    if (seen.has(normalized)) {
      continue;
    }
    const sensitivity = classifyShellPathSensitivity(normalized);
    if (sensitivity !== 'secret' && sensitivity !== 'credential') {
      continue;
    }
    seen.add(normalized);
    resources.push({
      kind: 'file',
      operation: shellFileOperation(verb, tokens, candidate, copyTargetIndex),
      target: candidate.value,
      scope: canonicalFileScope(normalized, workspaceDir),
      sensitivity,
    });
  }
  return resources;
}

// Package and directory names such as `packages/token-service` are ordinary
// shell arguments, so the shell classifier only protects paths that name a
// sensitive file or live under `.ssh/` or `secrets/`.
function classifyShellPathSensitivity(value: string): SecuritySensitivity {
  const segments = value.toLowerCase().split('/');
  const basename = segments[segments.length - 1] ?? '';
  const directories = segments.slice(0, -1);
  if (directories.includes('.ssh')) {
    return 'credential';
  }
  if (directories.some((segment) => /^secrets?$/.test(segment))) {
    return 'secret';
  }
  if (isSensitiveShellName(shellGlobPrefix(basename) || basename)) {
    return /^(\.env|\.npmrc|\.pypirc)/.test(basename) ? 'secret' : 'credential';
  }
  if (/\.(pem|key)$/.test(basename)) {
    return 'credential';
  }
  return 'normal';
}

// A bare `id_rsa`, `token`, or `.env` is only meaningful as a secret when it is
// the whole argument name; names that merely contain one (`build.token`) stay
// ordinary arguments.
function isSensitiveShellName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SHELL_SENSITIVE_NAMES.test(lower) || SHELL_SENSITIVE_FILES.test(lower)) {
    return true;
  }
  return /^\.env(\.|~|$)/.test(lower);
}

function shellGlobPrefix(value: string): string {
  if (!SHELL_GLOB_CHAR.test(value)) {
    return '';
  }
  return value.slice(0, value.search(SHELL_GLOB_CHAR)).replace(/\.$/, '');
}

function shellVerb(tokens: string[]): string {
  const commands = [...SHELL_DELETE_COMMANDS, ...SHELL_WRITE_COMMANDS, ...SHELL_COPY_COMMANDS];
  for (const token of tokens) {
    const name = path.basename(token.replace(SHELL_REDIRECT_PREFIX, '')).toLowerCase();
    if (commands.includes(name)) {
      return name;
    }
  }
  for (const token of tokens) {
    if (!token || SHELL_LOGIN_PREFIX.test(token) || token.startsWith('-')) {
      continue;
    }
    if (SHELL_WRAPPERS.has(path.basename(token).toLowerCase())) {
      continue;
    }
    return path.basename(token).toLowerCase();
  }
  return '';
}

function shellCopyTargetIndex(tokens: string[]): number | undefined {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index] ?? '';
    if (!token || token.startsWith('-') || SHELL_REDIRECT_TOKEN.test(token)) {
      continue;
    }
    return index;
  }
  return undefined;
}

function shellFileOperation(
  verb: string,
  tokens: string[],
  candidate: ShellPathCandidate,
  copyTargetIndex: number | undefined,
): SecurityOperation {
  if (SHELL_DELETE_COMMANDS.has(verb)) {
    return 'delete';
  }
  if (candidate.redirect || SHELL_REDIRECT_TOKEN.test(tokens[candidate.index - 1] ?? '')) {
    return 'write';
  }
  if (SHELL_COPY_COMMANDS.has(verb)) {
    return candidate.index === copyTargetIndex ? 'write' : 'read';
  }
  return SHELL_WRITE_COMMANDS.has(verb) ? 'write' : 'read';
}

function splitShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (const char of command) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char) || ';|&()`'.includes(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function shellPathCandidates(tokens: string[]): ShellPathCandidate[] {
  const candidates: ShellPathCandidate[] = [];
  for (const [index, token] of tokens.entries()) {
    const stripped = token.replace(SHELL_REDIRECT_PREFIX, '');
    // Quoted phrases keep their inner spaces, so `git commit -m "rotate token
    // in .env"` stays a message instead of becoming a path.
    if (!stripped || stripped !== stripped.trim() || /\s/.test(stripped)) {
      continue;
    }
    const assigned = stripped.includes('=') ? stripped.slice(stripped.indexOf('=') + 1) : stripped;
    if (!assigned || SHELL_URL.test(assigned)) {
      continue;
    }
    if (isShellPath(assigned)) {
      candidates.push({ value: assigned, index, redirect: stripped !== token });
    }
  }
  return candidates;
}

function isShellPath(value: string): boolean {
  if (value === '~' || value.startsWith('~/')) {
    return true;
  }
  if (value.includes('/')) {
    return true;
  }
  // Glob patterns only count when their literal prefix already names a
  // sensitive file (`cat .env*`), never for `ls *.pem` or `find -name "*.pem"`.
  if (SHELL_GLOB_CHAR.test(value)) {
    return isSensitiveShellName(shellGlobPrefix(value));
  }
  return value.startsWith('.') || isSensitiveShellName(value);
}

function expandShellHome(value: string): string {
  const home = process.env.HOME;
  if (!home) {
    return value;
  }
  if (value === '~') {
    return home;
  }
  return value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
}

export function canonicalizeSecurityPath(cwd: string | undefined, value: string): string {
  const absolute = path.resolve(cwd ?? process.cwd(), value);
  let existing = absolute;
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.resolve(realpathSync.native(existing), ...suffix);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return absolute;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function pathInside(value: string, parent: string): boolean {
  const relative = path.relative(parent, value);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function classifyPathSensitivity(value: string | undefined): SecuritySensitivity {
  const lower = value?.toLowerCase() ?? '';
  if (!lower) {
    return 'normal';
  }
  if (
    /(^|\/)\.ssh(\/|$)|id_rsa|id_ed25519|private[_-]?key|credential|password|token|secret|\.pem$|\.key$/i.test(
      lower,
    )
  ) {
    return 'credential';
  }
  if (/(^|\/)\.env(\.|$)|(^|\/)\.npmrc$|(^|\/)\.pypirc$|(^|\/)secrets?(\/|$)/i.test(lower)) {
    return 'secret';
  }
  if (
    /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|tsconfig\.json|dockerfile|docker-compose\.ya?ml)$/i.test(
      lower,
    )
  ) {
    return 'config';
  }
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|css|html|md)$/i.test(lower)) {
    return 'source';
  }
  return 'normal';
}

function matchesArgs(patterns: Record<string, string>, args: JsonObject): boolean {
  for (const [key, expected] of Object.entries(patterns)) {
    const actual = args[key];
    if (typeof actual !== 'string' || !matchesPattern(actual, expected)) {
      return false;
    }
  }
  return true;
}

function matchesArgsRegex(patterns: Record<string, string>, args: JsonObject): boolean {
  for (const [key, pattern] of Object.entries(patterns)) {
    const actual = args[key];
    if (typeof actual !== 'string' || !new RegExp(pattern).test(actual)) {
      return false;
    }
  }
  return true;
}

function matchesPattern(value: string, pattern: string): boolean {
  const normalizedValue = normalizePatternValue(value);
  const normalizedPattern = normalizePatternValue(pattern);
  if (normalizedPattern === '*') {
    return true;
  }
  if (normalizedPattern.endsWith(':*')) {
    return normalizedValue.startsWith(normalizedPattern.slice(0, -1));
  }
  if (normalizedPattern.endsWith('*')) {
    return normalizedValue.startsWith(normalizedPattern.slice(0, -1));
  }
  return normalizedValue === normalizedPattern;
}

function normalizePatternValue(value: string): string {
  return value.trim().toLowerCase();
}

function stringArg(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function riskRank(level: RiskLevel): number {
  return { low: 1, medium: 2, high: 3, critical: 4 }[level];
}

function summarizeTarget(value: string): string {
  return value.length > 200
    ? `${value.slice(0, 200)}...[${value.length - 200} chars truncated]`
    : value;
}

export { default } from './extension.js';
