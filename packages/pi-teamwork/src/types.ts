export type Issue = {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: string;
  assignee?: string;
  project?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type IssueCreateInput = {
  workspaceId?: string;
  title: string;
  description?: string;
  priority?: string;
  assignee?: string;
  project?: string;
};

export type IssueUpdateInput = {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  assignee?: string;
};

export type IssueListFilter = {
  workspaceId?: string;
  status?: string;
  assignee?: string;
  project?: string;
  limit?: number;
};

export type Comment = {
  id: string;
  issueId: string;
  content: string;
  author?: string;
  createdAt?: string;
  parentId?: string;
};

export type Project = {
  id: string;
  title: string;
  description?: string;
  status?: string;
  lead?: string;
};

export type Workspace = {
  id: string;
  name: string;
};

export type AgentSummary = {
  id: string;
  name: string;
  status?: string;
  role?: string;
  title?: string;
  urlKey?: string;
};

export type UserDirectoryEntry = {
  id: string;
  name: string;
  email?: string;
  role?: string;
  type?: string;
  status?: string;
};

export interface TeamworkProvider {
  name: string;
  listWorkspaces(): Promise<Workspace[]>;
  listIssues(filter?: IssueListFilter): Promise<Issue[]>;
  getIssue(id: string, workspaceId?: string): Promise<Issue | undefined>;
  createIssue(input: IssueCreateInput): Promise<Issue>;
  updateIssue(
    id: string,
    input: IssueUpdateInput,
    workspaceId?: string,
  ): Promise<Issue | undefined>;
  addComment(
    issueId: string,
    content: string,
    parentId?: string,
    workspaceId?: string,
  ): Promise<Comment>;
  listComments(issueId: string, workspaceId?: string): Promise<Comment[]>;
  listProjects(workspaceId?: string): Promise<Project[]>;
  listAgents?(workspaceId?: string): Promise<AgentSummary[]>;
  listUserDirectory?(filter?: {
    workspaceId?: string;
    q?: string;
    limit?: number;
  }): Promise<UserDirectoryEntry[]>;
  status(): Promise<Record<string, unknown>>;
}

export type ExecFn = (
  command: string,
  args: string[],
  options?: { env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export type MulticaAdapterConfig = {
  binary?: string;
  workspace?: string;
  token?: string;
  autoInstall?: boolean;
  serverUrl?: string;
  appUrl?: string;
};

export type AmasterAdapterConfig = {
  apiBase?: string;
  context?: string;
  profile?: string;
  authStore?: string;
  companyId?: string;
  apiKey?: string;
};

export type TeamworkConfig = {
  enabled?: boolean;
  provider?: string;
  multica?: MulticaAdapterConfig;
  amaster?: AmasterAdapterConfig;
};
