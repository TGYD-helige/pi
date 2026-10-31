import type {
  Comment,
  ExecFn,
  ExecutionOptions,
  Issue,
  IssueCreateInput,
  IssueListFilter,
  IssueUpdateInput,
  MulticaAdapterConfig,
  Project,
  TeamworkProvider,
  Workspace,
} from '../types.js';

export type InstallResult = {
  installed: boolean;
  alreadyPresent: boolean;
  error?: string;
};

export type InitMulticaResult = {
  adapter: MulticaAdapter;
  installResult: InstallResult;
};

export async function initMulticaProvider(
  config: MulticaAdapterConfig,
  exec: ExecFn,
): Promise<InitMulticaResult> {
  const binary = config.binary?.trim() || 'multica';
  let available = false;
  try {
    available = (await exec(binary, ['--version'])).code === 0;
  } catch {
    available = false;
  }
  const installResult: InstallResult = available
    ? { installed: true, alreadyPresent: true }
    : {
        installed: false,
        alreadyPresent: false,
        error: 'install a pinned multica release manually',
      };
  if (!installResult.installed) {
    return { adapter: new MulticaAdapter(config, exec), installResult };
  }

  if (config.serverUrl) {
    try {
      await exec(binary, ['config', 'set', 'server_url', config.serverUrl]);
    } catch {
      // Config may already be set
    }
    if (config.appUrl) {
      try {
        await exec(binary, ['config', 'set', 'app_url', config.appUrl]);
      } catch {
        // Config may already be set
      }
    }
  }

  try {
    await exec(binary, ['daemon', 'start']);
  } catch {
    // Daemon may already be running
  }

  if (config.token) {
    try {
      await exec(binary, ['login', '--token', config.token]);
    } catch {
      // Login may already be done
    }
  }

  return { adapter: new MulticaAdapter(config, exec), installResult };
}

export class MulticaAdapter implements TeamworkProvider {
  readonly name = 'multica';
  private readonly binary: string;
  private readonly defaultWorkspaceArgs: string[];

  constructor(
    private readonly config: MulticaAdapterConfig,
    private readonly exec: ExecFn,
    private readonly execution?: ExecutionOptions,
  ) {
    this.binary = config.binary?.trim() || 'multica';
    this.defaultWorkspaceArgs = config.workspace?.trim()
      ? ['--workspace-id', config.workspace.trim()]
      : [];
  }

  withExecution(options: ExecutionOptions): TeamworkProvider {
    return new MulticaAdapter(this.config, this.exec, options);
  }

  private wsArgs(workspaceId?: string): string[] {
    return workspaceId ? ['--workspace-id', workspaceId] : this.defaultWorkspaceArgs;
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const result = await this.run(['workspace', 'list', '--output', 'json']);
    const data = parseJson(result);
    if (!Array.isArray(data)) return [];
    return data.map((item) => ({
      id: String(item.id ?? ''),
      name: String(item.name ?? item.title ?? ''),
    }));
  }

  async listIssues(filter?: IssueListFilter): Promise<Issue[]> {
    const wsArgs = this.wsArgs(filter?.workspaceId);
    const args = ['issue', 'list', '--output', 'json', ...wsArgs];
    if (filter?.status) args.push('--status', filter.status);
    if (filter?.assignee) args.push('--assignee', filter.assignee);
    if (filter?.project) args.push('--project', filter.project);
    if (filter?.limit) args.push('--limit', String(filter.limit));
    const result = await this.run(args);
    const data = parseJson(result);
    if (!Array.isArray(data)) return [];
    return data.map(mapIssue);
  }

  async getIssue(id: string, workspaceId?: string): Promise<Issue | undefined> {
    const result = await this.run([
      'issue',
      'get',
      id,
      '--output',
      'json',
      ...this.wsArgs(workspaceId),
    ]);
    const data = parseJson(result);
    if (!data || typeof data !== 'object') return undefined;
    return mapIssue(data);
  }

  async createIssue(input: IssueCreateInput): Promise<Issue> {
    const wsArgs = this.wsArgs(input.workspaceId);
    const args = ['issue', 'create', '--title', input.title, ...wsArgs];
    if (input.description) args.push('--description', input.description);
    if (input.priority) args.push('--priority', input.priority);
    if (input.assignee) args.push('--assignee', input.assignee);
    if (input.project) args.push('--project', input.project);
    const result = await this.run(args);
    const data = parseJson(result);
    if (data && typeof data === 'object') return mapIssue(data);
    return { id: 'unknown', title: input.title, status: 'todo' };
  }

  async updateIssue(
    id: string,
    input: IssueUpdateInput,
    workspaceId?: string,
  ): Promise<Issue | undefined> {
    const wsArgs = this.wsArgs(workspaceId);
    if (input.status) {
      await this.run(['issue', 'status', id, input.status, ...wsArgs]);
    }
    const updateArgs: string[] = [];
    if (input.title) updateArgs.push('--title', input.title);
    if (input.description) updateArgs.push('--description', input.description);
    if (input.priority) updateArgs.push('--priority', input.priority);
    if (input.assignee) updateArgs.push('--assignee', input.assignee);
    if (updateArgs.length > 0) {
      await this.run(['issue', 'update', id, ...updateArgs, ...wsArgs]);
    }
    return this.getIssue(id, workspaceId);
  }

  async addComment(
    issueId: string,
    content: string,
    parentId?: string,
    workspaceId?: string,
  ): Promise<Comment> {
    const wsArgs = this.wsArgs(workspaceId);
    const args = ['issue', 'comment', 'add', issueId, '--content', content, ...wsArgs];
    if (parentId) args.push('--parent', parentId);
    const result = await this.run(args);
    const data = parseJson(result);
    if (data && typeof data === 'object') {
      return {
        id: String((data as Record<string, unknown>).id ?? 'unknown'),
        issueId,
        content,
        author: String((data as Record<string, unknown>).author ?? ''),
        createdAt: String((data as Record<string, unknown>).created_at ?? ''),
        ...(parentId ? { parentId } : {}),
      };
    }
    return { id: 'unknown', issueId, content };
  }

  async listComments(issueId: string, workspaceId?: string): Promise<Comment[]> {
    const result = await this.run([
      'issue',
      'comment',
      'list',
      issueId,
      '--output',
      'json',
      ...this.wsArgs(workspaceId),
    ]);
    const data = parseJson(result);
    if (!Array.isArray(data)) return [];
    return data.map((item) => ({
      id: String(item.id ?? ''),
      issueId,
      content: String(item.content ?? item.body ?? ''),
      author: String(item.author ?? item.user ?? ''),
      createdAt: String(item.created_at ?? ''),
      ...(item.parent_id ? { parentId: String(item.parent_id) } : {}),
    }));
  }

  async listProjects(workspaceId?: string): Promise<Project[]> {
    const result = await this.run([
      'project',
      'list',
      '--output',
      'json',
      ...this.wsArgs(workspaceId),
    ]);
    const data = parseJson(result);
    if (!Array.isArray(data)) return [];
    return data.map((item) => ({
      id: String(item.id ?? ''),
      title: String(item.title ?? item.name ?? ''),
      ...(item.description ? { description: String(item.description) } : {}),
      ...(item.status ? { status: String(item.status) } : {}),
      ...(item.lead ? { lead: String(item.lead) } : {}),
    }));
  }

  async status(): Promise<Record<string, unknown>> {
    const result = await this.run(['daemon', 'status', '--output', 'json']);
    const data = parseJson(result);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    return { raw: result };
  }

  private async run(args: string[]): Promise<string> {
    this.execution?.signal?.throwIfAborted();
    if (this.execution && Date.now() >= this.execution.deadline)
      throw new Error('Teamwork operation timed out.');
    const { stdout, stderr, code } = await (this.execution
      ? this.exec(this.binary, args, this.execution)
      : this.exec(this.binary, args));
    this.execution?.signal?.throwIfAborted();
    if (this.execution && Date.now() >= this.execution.deadline)
      throw new Error('Teamwork operation timed out.');
    if (code !== 0) {
      const message = stderr.trim() || stdout.trim() || `Exit code ${code}`;
      throw new Error(`multica ${args[0]} failed: ${message}`);
    }
    return stdout;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

function mapIssue(raw: unknown): Issue {
  const item = raw as Record<string, unknown>;
  return {
    id: String(item.id ?? ''),
    title: String(item.title ?? ''),
    status: String(item.status ?? 'unknown'),
    ...(item.description ? { description: String(item.description) } : {}),
    ...(item.priority ? { priority: String(item.priority) } : {}),
    ...(item.assignee ? { assignee: String(item.assignee) } : {}),
    ...(item.project ? { project: String(item.project) } : {}),
    ...(item.created_at ? { createdAt: String(item.created_at) } : {}),
    ...(item.updated_at ? { updatedAt: String(item.updated_at) } : {}),
    ...(item.metadata && typeof item.metadata === 'object'
      ? { metadata: item.metadata as Record<string, unknown> }
      : {}),
  };
}
