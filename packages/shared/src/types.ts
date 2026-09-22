import type { AiLabelDefinition } from './labels.js';

export type ProviderKind = 'github' | 'gitea' | 'gitee';

export const PROVIDER_KINDS: readonly ProviderKind[] = ['github', 'gitea', 'gitee'];

export interface ProviderMeta {
  kind: ProviderKind;
  label: string;
  /** Default API base url, `null` means the value must be provided by the user. */
  defaultBaseUrl: string | null;
  /** Whether the account needs an explicit base url (self hosted instances). */
  requiresBaseUrl: boolean;
  tokenHelpUrl: string;
  /** "owner/name" style repository identifier used in the UI. */
  slugPlaceholder: string;
}

export const PROVIDER_META: Readonly<Record<ProviderKind, ProviderMeta>> = {
  github: {
    kind: 'github',
    label: 'GitHub',
    defaultBaseUrl: 'https://api.github.com',
    requiresBaseUrl: false,
    tokenHelpUrl: 'https://github.com/settings/tokens?type=beta',
    slugPlaceholder: 'owner/repo',
  },
  gitea: {
    kind: 'gitea',
    label: 'Gitea / Forgejo',
    defaultBaseUrl: null,
    requiresBaseUrl: true,
    tokenHelpUrl: 'https://docs.gitea.com/development/oauth2-provider',
    slugPlaceholder: 'owner/repo',
  },
  gitee: {
    kind: 'gitee',
    label: 'Gitee 码云',
    defaultBaseUrl: 'https://gitee.com/api/v5',
    requiresBaseUrl: false,
    tokenHelpUrl: 'https://gitee.com/personal_access_tokens',
    slugPlaceholder: 'owner/repo',
  },
};

export type AccountStatus = 'unknown' | 'ok' | 'error';

export interface Account {
  id: string;
  name: string;
  provider: ProviderKind;
  baseUrl: string;
  username: string | null;
  avatarUrl: string | null;
  displayName: string | null;
  status: AccountStatus;
  statusMessage: string | null;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  /** Masked representation of the stored token, e.g. `ghp_…9f2c`. */
  tokenPreview: string | null;
  repositoryCount: number;
}

export interface Repository {
  id: string;
  accountId: string;
  accountName: string;
  provider: ProviderKind;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  private: boolean;
  description: string | null;
  enabled: boolean;
  labelsInitialized: boolean;
  labelSyncedAt: string | null;
  lastPolledAt: string | null;
  lastPollError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteRepositorySummary {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  private: boolean;
  description: string | null;
  updatedAt: string | null;
  imported: boolean;
  repositoryId: string | null;
}

export interface RemoteLabel {
  name: string;
  color: string;
  description: string | null;
  id: string | number | null;
}

export interface RemoteUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
}

export interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  url: string | null;
}

export interface RemoteIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  author: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  comments: number;
  isPullRequest: boolean;
}

export interface RemotePullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  labels: string[];
  author: string;
  htmlUrl: string;
  headRef: string;
  baseRef: string;
  headSha: string | null;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
}

export interface TrackedIssue {
  id: string;
  repositoryId: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  author: string;
  htmlUrl: string;
  updatedAt: string;
  isPullRequest: boolean;
  aiStatus: string | null;
  priority: TaskPriority;
  paused: boolean;
  stuck: boolean;
}

export type TaskPriority = 'high' | 'normal' | 'low';

export type TaskKind = 'implement' | 'review' | 'fix';

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type EngineId = 'codex' | 'claude';

export interface Task {
  id: string;
  repositoryId: string;
  repositoryFullName: string;
  kind: TaskKind;
  status: TaskStatus;
  engine: EngineId;
  priority: TaskPriority;
  issueNumber: number | null;
  issueTitle: string | null;
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
  workspace: string | null;
  summary: string | null;
  error: string | null;
  attempts: number;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export type LogStream = 'system' | 'stdout' | 'stderr' | 'agent' | 'command' | 'git';

export interface TaskLogLine {
  id: number;
  taskId: string;
  ts: string;
  stream: LogStream;
  message: string;
}

export interface ActivityEntry {
  id: number;
  ts: string;
  level: 'info' | 'success' | 'warning' | 'error';
  scope: string;
  repositoryId: string | null;
  repositoryFullName: string | null;
  message: string;
}

export interface CodexCapabilities {
  execCommand: boolean;
  jsonOutput: boolean;
  sandboxFlag: boolean;
  /** `codex exec` has no `--ask-for-approval` flag; approvals go through `-c`. */
  configOverride: boolean;
  cdFlag: boolean;
  skipGitRepoCheck: boolean;
  modelFlag: boolean;
  outputLastMessage: boolean;
  outputSchema: boolean;
  ephemeral: boolean;
  reviewSubcommand: boolean;
  updateSubcommand: boolean;
  raw: string;
}

export interface CodexStatus {
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  /** How the binary was resolved: `configured`, `path` or `missing`. */
  source: 'configured' | 'path' | 'missing';
  configPath: string;
  configExists: boolean;
  capabilities: CodexCapabilities | null;
  /** Result of the last model probe, `null` means no probe ran yet. */
  modelProbe: CodexModelProbe | null;
  checkedAt: string;
  /** Populated when the CLI is present but a probe failed. */
  warning: string | null;
}

/**
 * Outcome of the model probe: a minimal `codex exec` run that only checks
 * whether the configured model answers. AutoGit never inspects credentials.
 */
export interface CodexModelProbe {
  /** `true` when the model answered, `false` when the call failed, `null` when it could not run. */
  ready: boolean | null;
  /** Answer excerpt or failure reason, shown in the UI. */
  message: string | null;
  /** Wall clock duration of the probe command in milliseconds. */
  durationMs: number | null;
  checkedAt: string;
}

export interface CodexConfigPayload {
  path: string;
  content: string;
  parsed: Record<string, unknown> | null;
  parseError: string | null;
  /**
   * A few first class fields surfaced for the UI form. Everything else stays
   * editable through the raw TOML editor.
   */
  highlights: {
    model: string | null;
    modelReasoningEffort: string | null;
    approvalPolicy: string | null;
    sandboxMode: string | null;
  };
}

export interface CodexInstallState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  command: string | null;
  /** Ring buffer of the last lines, streamed live to the UI. */
  lines: Array<{ ts: string; stream: LogStream; message: string }>;
}

export interface LabelSyncResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  failed: Array<{ name: string; error: string }>;
  syncedAt: string;
}

export interface RepositoryOverview {
  repository: Repository;
  counts: {
    todo: number;
    doing: number;
    inReview: number;
    verify: number;
    needsReview: number;
    needsFix: number;
    approved: number;
    stuck: number;
    paused: number;
  };
  issues: TrackedIssue[];
  pullRequests: TrackedIssue[];
  tasks: Task[];
  lastSyncedAt: string | null;
}

export interface OrchestratorStatus {
  running: boolean;
  pollSeconds: number;
  maxConcurrent: number;
  runningTaskIds: string[];
  queuedTaskIds: string[];
  lastTickAt: string | null;
  nextTickAt: string | null;
  lastTickError: string | null;
  repositories: Array<{
    repositoryId: string;
    fullName: string;
    enabled: boolean;
    lastPolledAt: string | null;
    lastPollError: string | null;
    trackedIssues: number;
  }>;
}

export interface AppSettings {
  pollSeconds: number;
  maxConcurrentTasks: number;
  autoInitializeLabels: boolean;
  autoReview: boolean;
  autoFix: boolean;
  allowClaudeFallback: boolean;
  codexPath: string | null;
  codexModel: string | null;
  codexSandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  codexApprovalPolicy: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  codexExtraArgs: string[];
  commitAuthorName: string;
  commitAuthorEmail: string;
  taskTimeoutMinutes: number;
  branchPrefix: string;
  labelPrefix: string;
  prTitleTemplate: string;
}

export interface LabelPreviewRow extends AiLabelDefinition {
  existsRemotely: boolean | null;
}
