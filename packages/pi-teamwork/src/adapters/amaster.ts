import type {
  AgentSummary,
  AmasterAdapterConfig,
  Comment,
  ExecFn,
  Issue,
  IssueCreateInput,
  IssueListFilter,
  IssueUpdateInput,
  Project,
  TeamworkProvider,
  UserDirectoryEntry,
  Workspace,
} from '../types.js';

type ExecResult = Awaited<ReturnType<ExecFn>>;

export async function initAmasterProvider(
  config: AmasterAdapterConfig,
  exec: ExecFn,
): Promise<TeamworkProvider> {
  return new AmasterAdapter(config, exec);
}

export class AmasterAdapter implements TeamworkProvider {
  readonly name = 'amaster';
  private readonly binary = 'amaster-employee';
  private readonly runtimeBinary = 'amaster-runtime';
  private readonly apiKey?: string;
  private readonly commonArgs: string[];
  private readonly defaultCompanyId?: string;
  private discoveredCompanyId: string | undefined;
  private workspaceDiscoveryPromise: Promise<string | undefined> | undefined;

  constructor(
    config: AmasterAdapterConfig,
    private readonly exec: ExecFn,
  ) {
    const apiKey = config.apiKey?.trim();
    if (apiKey) this.apiKey = apiKey;
    this.commonArgs = [];
    if (config.apiBase?.trim()) this.commonArgs.push('--api-base', config.apiBase.trim());
    if (config.context?.trim()) this.commonArgs.push('--context', config.context.trim());
    if (config.profile?.trim()) this.commonArgs.push('--profile', config.profile.trim());
    if (config.authStore?.trim()) this.commonArgs.push('--auth-store', config.authStore.trim());
    if (config.companyId?.trim()) this.defaultCompanyId = config.companyId.trim();
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const data = parseRequiredJsonArray(
      await this.runAmaster(withJson(await this.buildArgs(['company', 'list'], undefined, false))),
      'AMaster company list',
    );
    return data.map(mapWorkspace);
  }

  async listIssues(filter?: IssueListFilter): Promise<Issue[]> {
    const args = await this.buildArgs(['issue', 'list'], filter?.workspaceId);
    if (filter?.status) args.push('--status', filter.status);
    if (filter?.assignee) args.push('--assignee', filter.assignee);
    if (filter?.project) args.push('--project', filter.project);
    if (filter?.limit) args.push('--limit', String(filter.limit));
    args.push('--json');
    const data = parseRequiredJsonArray(await this.runAmaster(args), 'AMaster issue list');
    return data.map(mapIssue);
  }

  async getIssue(id: string, workspaceId?: string): Promise<Issue | undefined> {
    const data = parseRequiredJson(
      await this.runAmaster(withJson(await this.buildArgs(['issue', 'get', id], workspaceId))),
      'AMaster issue get',
    );
    const issue = unwrapIssue(data);
    if (!isIssueRecord(issue)) return undefined;
    return mapIssue(issue);
  }

  async createIssue(input: IssueCreateInput): Promise<Issue> {
    const args = await this.buildArgs(
      ['issue', 'create', '--title', input.title],
      input.workspaceId,
    );
    if (input.description) args.push('--description', input.description);
    if (input.priority) args.push('--priority', input.priority);
    if (input.assignee) args.push('--assignee', input.assignee);
    if (input.project) args.push('--project', input.project);
    args.push('--json');
    const data = parseRequiredJson(await this.runAmaster(args), 'AMaster issue create');
    const issue = unwrapIssue(data);
    if (isIssueRecord(issue)) return mapIssue(issue);
    throw new Error('AMaster issue create did not return a created issue.');
  }

  async updateIssue(
    id: string,
    input: IssueUpdateInput,
    workspaceId?: string,
  ): Promise<Issue | undefined> {
    const args = await this.buildArgs(['issue', 'update', id], workspaceId);
    if (input.title) args.push('--title', input.title);
    if (input.description) args.push('--description', input.description);
    if (input.status) args.push('--status', input.status);
    if (input.priority) args.push('--priority', input.priority);
    if (input.assignee) args.push('--assignee', input.assignee);
    args.push('--json');
    const data = parseRequiredJson(await this.runAmaster(args), 'AMaster issue update');
    const issue = unwrapIssue(data);
    if (isIssueRecord(issue)) return mapIssue(issue);
    return this.getIssue(id, workspaceId);
  }

  async addComment(
    issueId: string,
    content: string,
    _parentId?: string,
    workspaceId?: string,
  ): Promise<Comment> {
    const args = ['issue', 'comment', issueId, '--content', content];
    const data = parseRequiredJson(
      await this.runAmaster(withJson(await this.buildArgs(args, workspaceId))),
      'AMaster issue comment',
    );
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const item = data as Record<string, unknown>;
      const id = stringValue(item.id ?? item.commentId);
      if (!id) throw new Error('AMaster issue comment did not return a created comment.');
      return {
        id,
        issueId,
        content: String(item.content ?? item.body ?? content),
        ...optionalString('author', item.author ?? item.authorName),
        ...optionalString('createdAt', item.createdAt ?? item.created_at),
      };
    }
    throw new Error('AMaster issue comment did not return a created comment.');
  }

  async listComments(issueId: string, workspaceId?: string): Promise<Comment[]> {
    const summary = await this.getIssue(issueId, workspaceId);
    const comments = collectCommentRecords(summary?.metadata);
    return comments.map((item) => {
      const record = item as Record<string, unknown>;
      return {
        id: String(record.id ?? record.commentId ?? ''),
        issueId,
        content: String(record.content ?? record.body ?? ''),
        ...optionalString('author', record.author ?? record.authorName),
        ...optionalString('createdAt', record.createdAt ?? record.created_at),
      };
    });
  }

  async listProjects(workspaceId?: string): Promise<Project[]> {
    const data = parseRequiredJsonArray(
      await this.runAmaster(withJson(await this.buildArgs(['project', 'list'], workspaceId))),
      'AMaster project list',
    );
    return data.map((item) => {
      const record = item as Record<string, unknown>;
      return {
        id: String(record.id ?? ''),
        title: String(record.title ?? record.name ?? ''),
        ...optionalString('description', record.description),
        ...optionalString('status', record.status),
        ...optionalString('lead', record.lead),
      };
    });
  }

  async listAgents(workspaceId?: string): Promise<AgentSummary[]> {
    const data = parseRequiredJsonArray(
      await this.runAmaster(withJson(await this.buildArgs(['agent', 'list'], workspaceId))),
      'AMaster agent list',
    );
    return data.map((item) => {
      const record = item as Record<string, unknown>;
      return {
        id: String(record.id ?? ''),
        name: String(record.name ?? record.title ?? ''),
        ...optionalString('status', record.status),
        ...optionalString('role', record.role),
        ...optionalString('title', record.title),
        ...optionalString('urlKey', record.urlKey ?? record.url_key),
      };
    });
  }

  async listUserDirectory(filter?: {
    workspaceId?: string;
    q?: string;
    limit?: number;
  }): Promise<UserDirectoryEntry[]> {
    const args = await this.buildArgs(['user-directory', 'list'], filter?.workspaceId);
    if (filter?.q) args.push('--q', filter.q);
    if (filter?.limit) args.push('--limit', String(filter.limit));
    args.push('--json');
    const data = parseRequiredJsonArray(await this.runAmaster(args), 'AMaster user-directory list');
    return data.map((item) => {
      const record = item as Record<string, unknown>;
      return {
        id: String(record.id ?? record.userId ?? record.email ?? ''),
        name: String(record.name ?? record.displayName ?? record.email ?? ''),
        ...optionalString('email', record.email),
        ...optionalString('role', record.role),
        ...optionalString('type', record.type ?? record.kind),
        ...optionalString('status', record.status),
      };
    });
  }

  async status(): Promise<Record<string, unknown>> {
    const [teamwork, runtime] = await Promise.all([
      this.runOptional(
        this.binary,
        withJson(this.buildArgsSync(['status'])),
        this.amasterExecOptions(),
      ),
      this.runOptional(this.runtimeBinary, ['daemon', 'status']),
    ]);
    return {
      provider: 'amaster',
      teamwork: parseJsonOrRaw(teamwork.stdout),
      runtime: parseJsonOrRaw(runtime.stdout),
      ok: teamwork.code === 0,
      runtimeOk: runtime.code === 0,
      authenticated: teamwork.code === 0,
      localRuntimeAttached: runtime.code === 0 && /running|ready|attached/i.test(runtime.stdout),
      ...(teamwork.code !== 0 ? { error: classifyAmasterFailure('employee', teamwork) } : {}),
      ...(runtime.code !== 0 ? { runtimeError: classifyAmasterFailure('runtime', runtime) } : {}),
    };
  }

  private async runAmaster(args: string[]): Promise<string> {
    const result = await this.exec(this.binary, args, this.amasterExecOptions());
    if (result.code !== 0) {
      throw new Error(`amaster ${args[0]} failed: ${classifyAmasterFailure('employee', result)}`);
    }
    return result.stdout;
  }

  private async runOptional(
    command: string,
    args: string[],
    options?: Parameters<ExecFn>[2],
  ): Promise<ExecResult> {
    try {
      return await this.exec(command, args, options);
    } catch (error) {
      return {
        stdout: '',
        stderr: redactText(error instanceof Error ? error.message : String(error)),
        code: 1,
      };
    }
  }

  private async buildArgs(
    args: string[],
    workspaceId?: string,
    useDefaultCompany = true,
  ): Promise<string[]> {
    const next = [...args, ...this.commonArgs];
    const companyId =
      normalizeWorkspaceId(workspaceId) ??
      (useDefaultCompany ? await this.resolveDefaultCompanyId() : undefined);
    if (companyId) next.push('-C', companyId);
    return next;
  }

  private buildArgsSync(args: string[], workspaceId?: string, useDefaultCompany = true): string[] {
    const next = [...args, ...this.commonArgs];
    const companyId =
      normalizeWorkspaceId(workspaceId) ?? (useDefaultCompany ? this.defaultCompanyId : undefined);
    if (companyId) next.push('-C', companyId);
    return next;
  }

  private async resolveDefaultCompanyId(): Promise<string | undefined> {
    if (this.defaultCompanyId) return this.defaultCompanyId;
    if (this.discoveredCompanyId) return this.discoveredCompanyId;
    this.workspaceDiscoveryPromise ??= this.discoverSingleCompanyId();
    this.discoveredCompanyId = await this.workspaceDiscoveryPromise;
    return this.discoveredCompanyId;
  }

  private async discoverSingleCompanyId(): Promise<string | undefined> {
    const workspaces = await this.listWorkspaces();
    if (workspaces.length === 0) return undefined;
    if (workspaces.length === 1) return workspaces[0]!.id;
    throw new Error(
      'Multiple AMaster workspaces are available; pass workspaceId from workspace_list.',
    );
  }

  private amasterExecOptions(): Parameters<ExecFn>[2] {
    return this.apiKey ? { env: { AMASTER_BOARD_API_KEY: this.apiKey } } : undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return sanitizeValue(JSON.parse(text.trim()));
  } catch {
    return undefined;
  }
}

function parseRequiredJson(text: string, label: string): unknown {
  const parsed = parseJson(text);
  if (parsed === undefined) throw new Error(`${label} did not return valid JSON.`);
  return parsed;
}

function parseRequiredJsonArray(text: string, label: string): unknown[] {
  const parsed = parseJson(text);
  if (!Array.isArray(parsed)) throw new Error(`${label} did not return a JSON array.`);
  return parsed;
}

function parseJsonOrRaw(text: string): unknown {
  const parsed = parseJson(text);
  if (parsed !== undefined) return parsed;
  return redactText(text);
}

function mapWorkspace(raw: unknown): Workspace {
  const item = asRecord(raw);
  if (!item) throw new Error('AMaster company list returned a malformed workspace.');
  const id = requiredString(item.id ?? item.companyId);
  return {
    id,
    name: String(item.name ?? item.title ?? item.urlKey ?? id),
  };
}

function mapIssue(raw: unknown): Issue {
  const item = asRecord(raw);
  if (!item) throw new Error('AMaster issue response did not contain an issue object.');
  const id = requiredString(item.id ?? item.identifier);
  const metadata = buildIssueMetadata(item);
  return {
    id,
    title: String(item.title ?? ''),
    status: String(item.status ?? 'unknown'),
    ...optionalString('description', item.description),
    ...optionalString('priority', item.priority),
    ...optionalString('assignee', item.assignee ?? item.assigneeName),
    ...optionalString('project', item.project ?? item.projectId),
    ...optionalString('createdAt', item.createdAt ?? item.created_at),
    ...optionalString('updatedAt', item.updatedAt ?? item.updated_at),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function buildIssueMetadata(item: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (ISSUE_TOP_LEVEL_FIELDS.has(key)) continue;
    metadata[key] = sanitizeValue(value);
  }
  for (const key of ['identifier', 'projectId']) {
    if (item[key] !== undefined) metadata[key] = sanitizeValue(item[key]);
  }
  return metadata;
}

function collectCommentRecords(metadata: Record<string, unknown> | undefined): unknown[] {
  if (!metadata) return [];
  const comments: unknown[] = [];
  appendCommentRecords(comments, metadata.comments);
  const nestedMetadata = asRecord(metadata.metadata);
  appendCommentRecords(comments, nestedMetadata?.comments);
  return comments;
}

function appendCommentRecords(output: unknown[], value: unknown): void {
  if (!Array.isArray(value)) return;
  output.push(...value);
}

const ISSUE_TOP_LEVEL_FIELDS = new Set([
  'id',
  'title',
  'status',
  'description',
  'priority',
  'assignee',
  'assigneeName',
  'project',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
]);

function unwrapIssue(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const item = raw as Record<string, unknown>;
  if (item.issue && typeof item.issue === 'object' && !Array.isArray(item.issue)) return item.issue;
  return raw;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== 'object')
    return typeof value === 'string' ? redactText(value) : value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? '[redacted]' : sanitizeValue(raw);
  }
  return out;
}

function classifyAmasterFailure(kind: 'employee' | 'runtime', result: ExecResult): string {
  const output = redactText(result.stderr || result.stdout || `Exit code ${result.code}`);
  const lower = output.toLowerCase();
  if (/enoent|not found|command not found|spawn .* no such file/i.test(output)) {
    return kind === 'runtime'
      ? 'AMaster runtime managed CLI wrapper is missing; runtime executor lease is unavailable, but task list/create can still work.'
      : 'AMaster Employee managed CLI wrapper is missing.';
  }
  if (/managed amaster employee cli|cli target|artifact|未安装|未构建/i.test(output)) {
    return 'Managed AMaster Employee CLI artifact is missing or not built.';
  }
  if (/401|unauthorized|not authenticated/.test(lower)) {
    return 'AMaster authentication failed. In Pi Agent LUI this means the login/session_start auth was not propagated; do not ask the user to paste tokens.';
  }
  if (kind === 'runtime') {
    return `Runtime daemon unavailable; only local executor lease is affected. ${output}`.trim();
  }
  return output.trim() || `Exit code ${result.code}`;
}

function isSensitiveKey(key: string): boolean {
  return /api[_-]?key|access[_-]?token|refresh[_-]?token|connector[_-]?token|token|secret|password|authorization|cookie|database[_-]?url|db[_-]?url/i.test(
    key,
  );
}

function redactText(text: unknown): string {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bamrtc(?:_pair)?_[A-Za-z0-9._~+/=-]+/g, '[redacted]')
    .replace(
      /(["']?(?:access_token|refresh_token|connectorToken|connector_token|apiKey|api_key|token|secret|password|authorization|cookie|databaseUrl|dbUrl)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      '$1[redacted]',
    );
}

function stringValue(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function requiredString(value: unknown): string {
  const normalized = stringValue(value)?.trim();
  if (!normalized) throw new Error('AMaster response did not contain a required id.');
  return normalized;
}

function normalizeWorkspaceId(workspaceId: string | undefined): string | undefined {
  const trimmed = workspaceId?.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function withJson(args: string[]): string[] {
  return [...args, '--json'];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isIssueRecord(value: unknown): value is Record<string, unknown> {
  const item = asRecord(value);
  if (!item) return false;
  const id = stringValue(item.id ?? item.identifier)?.trim();
  return Boolean(id);
}

function optionalString<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  const normalized = stringValue(value);
  return normalized === undefined ? {} : ({ [key]: normalized } as Record<K, string>);
}
