import type {
  Account,
  AccountStatus,
  ActivityEntry,
  EngineId,
  LogStream,
  ProviderKind,
  Repository,
  Task,
  TaskKind,
  TaskLogLine,
  TaskPriority,
  TaskStatus,
} from '@autogit/shared';

import { msBetween, nowIso } from '../util/time.js';
import { bool, type Db, fromBool, parseJsonArray, type SqlValue } from './database.js';

export interface AccountRecord extends Account {
  tokenEnc: string;
}

export interface RepositoryRecord extends Repository {}

export interface TaskRecord extends Task {}

export interface TaskCreateInput {
  id: string;
  repositoryId: string;
  kind: TaskKind;
  engine: EngineId;
  priority: TaskPriority;
  status?: TaskStatus;
  issueNumber?: number | null;
  issueTitle?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  branch?: string | null;
  workspace?: string | null;
}

export interface TaskPatch {
  status?: TaskStatus;
  engine?: EngineId;
  priority?: TaskPriority;
  issueNumber?: number | null;
  issueTitle?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  branch?: string | null;
  workspace?: string | null;
  summary?: string | null;
  error?: string | null;
  attempts?: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
}

export interface IssueUpsertInput {
  repositoryId: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  author: string | null;
  htmlUrl: string | null;
  updatedAt: string;
  isPullRequest: boolean;
}

export interface PullRequestUpsertInput {
  repositoryId: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  labels: string[];
  author: string | null;
  htmlUrl: string | null;
  headRef: string | null;
  baseRef: string | null;
  headSha: string | null;
  issueNumber: number | null;
  mergedAt: string | null;
  updatedAt: string;
}

export interface IssueRowRecord {
  id: string;
  repositoryId: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  author: string | null;
  htmlUrl: string | null;
  updatedAt: string;
  isPullRequest: boolean;
}

export interface PullRequestRowRecord {
  id: string;
  repositoryId: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  labels: string[];
  author: string | null;
  htmlUrl: string | null;
  headRef: string | null;
  baseRef: string | null;
  headSha: string | null;
  issueNumber: number | null;
  mergedAt: string | null;
  updatedAt: string;
}

interface AccountDbRow {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  token_enc: string;
  status: string;
  status_message: string | null;
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
  repository_count?: number;
}

interface RepositoryDbRow {
  id: string;
  account_id: string;
  account_name?: string;
  provider: string;
  owner: string;
  name: string;
  full_name: string;
  default_branch: string;
  html_url: string;
  clone_url: string;
  private: number;
  description: string | null;
  enabled: number;
  labels_initialized: number;
  label_synced_at: string | null;
  last_polled_at: string | null;
  last_poll_error: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskDbRow {
  id: string;
  repository_id: string;
  repository_full_name?: string;
  kind: string;
  status: string;
  engine: string;
  priority: string;
  issue_number: number | null;
  issue_title: string | null;
  pr_number: number | null;
  pr_url: string | null;
  branch: string | null;
  workspace: string | null;
  summary: string | null;
  error: string | null;
  attempts: number;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

const REPOSITORY_SELECT = `
  SELECT r.*, a.name AS account_name
  FROM repositories r
  JOIN accounts a ON a.id = r.account_id
`;

const TASK_SELECT = `
  SELECT t.*, r.full_name AS repository_full_name
  FROM tasks t
  JOIN repositories r ON r.id = t.repository_id
`;

export class Store {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- accounts

  createAccount(input: {
    id: string;
    name: string;
    provider: ProviderKind;
    baseUrl: string;
    tokenEnc: string;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    status: AccountStatus;
    statusMessage: string | null;
  }): AccountRecord {
    const ts = nowIso();
    this.db.run(
      `INSERT INTO accounts (id, name, provider, base_url, username, display_name, avatar_url, token_enc,
        status, status_message, created_at, updated_at, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        input.id,
        input.name,
        input.provider,
        input.baseUrl,
        input.username,
        input.displayName,
        input.avatarUrl,
        input.tokenEnc,
        input.status,
        input.statusMessage,
        ts,
        ts,
      ],
    );
    const record = this.getAccount(input.id);
    if (!record) throw new Error('Account insert failed');
    return record;
  }

  updateAccount(
    id: string,
    patch: {
      name?: string;
      baseUrl?: string;
      tokenEnc?: string;
      username?: string | null;
      displayName?: string | null;
      avatarUrl?: string | null;
      status?: AccountStatus;
      statusMessage?: string | null;
    },
  ): AccountRecord | null {
    const sets: string[] = [];
    const params: SqlValue[] = [];

    const assign = (column: string, value: SqlValue): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

    if (patch.name !== undefined) assign('name', patch.name);
    if (patch.baseUrl !== undefined) assign('base_url', patch.baseUrl);
    if (patch.tokenEnc !== undefined) assign('token_enc', patch.tokenEnc);
    if (patch.username !== undefined) assign('username', patch.username);
    if (patch.displayName !== undefined) assign('display_name', patch.displayName);
    if (patch.avatarUrl !== undefined) assign('avatar_url', patch.avatarUrl);
    if (patch.status !== undefined) assign('status', patch.status);
    if (patch.statusMessage !== undefined) assign('status_message', patch.statusMessage);

    assign('updated_at', nowIso());
    params.push(id);

    this.db.run(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.getAccount(id);
  }

  markAccountChecked(id: string, status: AccountStatus, message: string | null): void {
    this.db.run(
      'UPDATE accounts SET status = ?, status_message = ?, last_checked_at = ?, updated_at = ? WHERE id = ?',
      [status, message, nowIso(), nowIso(), id],
    );
  }

  getAccount(id: string): AccountRecord | null {
    const row = this.db.get<AccountDbRow>(
      `SELECT a.*, (SELECT COUNT(*) FROM repositories r WHERE r.account_id = a.id) AS repository_count
       FROM accounts a WHERE a.id = ?`,
      [id],
    );
    return row ? mapAccount(row) : null;
  }

  listAccounts(): AccountRecord[] {
    const rows = this.db.all<AccountDbRow>(
      `SELECT a.*, (SELECT COUNT(*) FROM repositories r WHERE r.account_id = a.id) AS repository_count
       FROM accounts a ORDER BY a.created_at ASC`,
    );
    return rows.map(mapAccount);
  }

  deleteAccount(id: string): void {
    this.db.run('DELETE FROM accounts WHERE id = ?', [id]);
  }

  // ------------------------------------------------------------ repositories

  upsertRepository(input: {
    id: string;
    accountId: string;
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
  }): RepositoryRecord {
    const ts = nowIso();
    this.db.run(
      `INSERT INTO repositories (id, account_id, provider, owner, name, full_name, default_branch,
        html_url, clone_url, private, description, enabled, labels_initialized, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT (account_id, full_name) DO UPDATE SET
         default_branch = excluded.default_branch,
         html_url = excluded.html_url,
         clone_url = excluded.clone_url,
         private = excluded.private,
         description = excluded.description,
         updated_at = excluded.updated_at`,
      [
        input.id,
        input.accountId,
        input.provider,
        input.owner,
        input.name,
        input.fullName,
        input.defaultBranch,
        input.htmlUrl,
        input.cloneUrl,
        bool(input.private),
        input.description,
        bool(input.enabled),
        ts,
        ts,
      ],
    );
    const record = this.getRepositoryByFullName(input.accountId, input.fullName);
    if (!record) throw new Error('Repository upsert failed');
    return record;
  }

  getRepositoryByFullName(accountId: string, fullName: string): RepositoryRecord | null {
    const row = this.db.get<RepositoryDbRow>(
      `${REPOSITORY_SELECT} WHERE r.account_id = ? AND r.full_name = ?`,
      [accountId, fullName],
    );
    return row ? mapRepository(row) : null;
  }

  getRepository(id: string): RepositoryRecord | null {
    const row = this.db.get<RepositoryDbRow>(`${REPOSITORY_SELECT} WHERE r.id = ?`, [id]);
    return row ? mapRepository(row) : null;
  }

  listRepositories(): RepositoryRecord[] {
    const rows = this.db.all<RepositoryDbRow>(`${REPOSITORY_SELECT} ORDER BY r.updated_at DESC`);
    return rows.map(mapRepository);
  }

  listEnabledRepositories(): RepositoryRecord[] {
    const rows = this.db.all<RepositoryDbRow>(
      `${REPOSITORY_SELECT} WHERE r.enabled = 1 ORDER BY r.updated_at DESC`,
    );
    return rows.map(mapRepository);
  }

  updateRepository(
    id: string,
    patch: {
      enabled?: boolean;
      defaultBranch?: string;
      labelsInitialized?: boolean;
      labelSyncedAt?: string | null;
      lastPolledAt?: string | null;
      lastPollError?: string | null;
      description?: string | null;
    },
  ): RepositoryRecord | null {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    const assign = (column: string, value: SqlValue): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

    if (patch.enabled !== undefined) assign('enabled', bool(patch.enabled));
    if (patch.defaultBranch !== undefined) assign('default_branch', patch.defaultBranch);
    if (patch.labelsInitialized !== undefined)
      assign('labels_initialized', bool(patch.labelsInitialized));
    if (patch.labelSyncedAt !== undefined) assign('label_synced_at', patch.labelSyncedAt);
    if (patch.lastPolledAt !== undefined) assign('last_polled_at', patch.lastPolledAt);
    if (patch.lastPollError !== undefined) assign('last_poll_error', patch.lastPollError);
    if (patch.description !== undefined) assign('description', patch.description);
    assign('updated_at', nowIso());
    params.push(id);

    this.db.run(`UPDATE repositories SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.getRepository(id);
  }

  deleteRepository(id: string): void {
    this.db.run('DELETE FROM repositories WHERE id = ?', [id]);
  }

  // ---------------------------------------------------------------- issues

  upsertIssue(input: IssueUpsertInput): void {
    const key = `${input.repositoryId}:${input.number}`;
    this.db.run(
      `INSERT INTO issues (id, repository_id, number, title, state, labels, author, html_url,
        updated_at, is_pull_request, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repository_id, number) DO UPDATE SET
         title = excluded.title,
         state = excluded.state,
         labels = excluded.labels,
         author = excluded.author,
         html_url = excluded.html_url,
         updated_at = excluded.updated_at,
         is_pull_request = excluded.is_pull_request,
         synced_at = excluded.synced_at`,
      [
        key,
        input.repositoryId,
        input.number,
        input.title,
        input.state,
        JSON.stringify(input.labels),
        input.author,
        input.htmlUrl,
        input.updatedAt,
        bool(input.isPullRequest),
        nowIso(),
      ],
    );
  }

  listIssues(repositoryId: string, filter: { state?: 'open' | 'closed' } = {}): IssueRowRecord[] {
    const clauses = ['repository_id = ?'];
    const params: SqlValue[] = [repositoryId];
    if (filter.state) {
      clauses.push('state = ?');
      params.push(filter.state);
    }
    const rows = this.db.all<{
      id: string;
      repository_id: string;
      number: number;
      title: string;
      state: string;
      labels: string;
      author: string | null;
      html_url: string | null;
      updated_at: string;
      is_pull_request: number;
    }>(`SELECT * FROM issues WHERE ${clauses.join(' AND ')} ORDER BY number DESC`, params);

    return rows.map((row) => ({
      id: row.id,
      repositoryId: row.repository_id,
      number: row.number,
      title: row.title,
      state: row.state === 'closed' ? 'closed' : 'open',
      labels: parseJsonArray(row.labels),
      author: row.author,
      htmlUrl: row.html_url,
      updatedAt: row.updated_at,
      isPullRequest: fromBool(row.is_pull_request),
    }));
  }

  /**
   * Snapshots that are still open on the remote.
   *
   * AutoGit only ever acts on open Issues/PRs, so boards and counters read
   * through this filter instead of the raw table — a closed (or merged) item
   * must never show up as pending work again.
   */
  listOpenIssues(repositoryId: string): IssueRowRecord[] {
    return this.listIssues(repositoryId, { state: 'open' });
  }

  // ----------------------------------------------------------- pull requests

  upsertPullRequest(input: PullRequestUpsertInput): void {
    const key = `${input.repositoryId}:${input.number}`;
    this.db.run(
      `INSERT INTO pull_requests (id, repository_id, number, title, state, merged, labels, author, html_url,
        head_ref, base_ref, head_sha, issue_number, merged_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repository_id, number) DO UPDATE SET
         title = excluded.title,
         state = excluded.state,
         merged = excluded.merged,
         labels = excluded.labels,
         author = excluded.author,
         html_url = excluded.html_url,
         head_ref = excluded.head_ref,
         base_ref = excluded.base_ref,
         head_sha = excluded.head_sha,
         issue_number = COALESCE(excluded.issue_number, pull_requests.issue_number),
         merged_at = excluded.merged_at,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at`,
      [
        key,
        input.repositoryId,
        input.number,
        input.title,
        input.state,
        bool(input.merged),
        JSON.stringify(input.labels),
        input.author,
        input.htmlUrl,
        input.headRef,
        input.baseRef,
        input.headSha,
        input.issueNumber,
        input.mergedAt,
        input.updatedAt,
        nowIso(),
      ],
    );
  }

  listPullRequests(
    repositoryId: string,
    filter: { state?: 'open' | 'closed' } = {},
  ): PullRequestRowRecord[] {
    const clauses = ['repository_id = ?'];
    const params: SqlValue[] = [repositoryId];
    if (filter.state) {
      clauses.push('state = ?');
      params.push(filter.state);
    }
    const rows = this.db.all<{
      id: string;
      repository_id: string;
      number: number;
      title: string;
      state: string;
      merged: number;
      labels: string;
      author: string | null;
      html_url: string | null;
      head_ref: string | null;
      base_ref: string | null;
      head_sha: string | null;
      issue_number: number | null;
      merged_at: string | null;
      updated_at: string;
    }>(`SELECT * FROM pull_requests WHERE ${clauses.join(' AND ')} ORDER BY number DESC`, params);

    return rows.map((row) => ({
      id: row.id,
      repositoryId: row.repository_id,
      number: row.number,
      title: row.title,
      state: row.state === 'closed' ? 'closed' : 'open',
      merged: fromBool(row.merged),
      labels: parseJsonArray(row.labels),
      author: row.author,
      htmlUrl: row.html_url,
      headRef: row.head_ref,
      baseRef: row.base_ref,
      headSha: row.head_sha,
      issueNumber: row.issue_number,
      mergedAt: row.merged_at,
      updatedAt: row.updated_at,
    }));
  }

  /** Open, unmerged PR snapshots — see `listOpenIssues()`. */
  listOpenPullRequests(repositoryId: string): PullRequestRowRecord[] {
    return this.listPullRequests(repositoryId, { state: 'open' }).filter((pr) => !pr.merged);
  }

  findPullRequestByHead(repositoryId: string, headRef: string): PullRequestRowRecord | null {
    const rows = this.listPullRequests(repositoryId);
    return rows.find((row) => row.headRef === headRef) ?? null;
  }

  setPullRequestIssueNumber(repositoryId: string, number: number, issueNumber: number): void {
    this.db.run(
      'UPDATE pull_requests SET issue_number = ? WHERE repository_id = ? AND number = ?',
      [issueNumber, repositoryId, number],
    );
  }

  // ------------------------------------------------------------------ tasks

  createTask(input: TaskCreateInput): TaskRecord {
    const ts = nowIso();
    this.db.run(
      `INSERT INTO tasks (id, repository_id, kind, status, engine, priority, issue_number, issue_title,
        pr_number, pr_url, branch, workspace, summary, error, attempts, queued_at, started_at, finished_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, NULL, NULL, NULL)`,
      [
        input.id,
        input.repositoryId,
        input.kind,
        input.status ?? 'queued',
        input.engine,
        input.priority,
        input.issueNumber ?? null,
        input.issueTitle ?? null,
        input.prNumber ?? null,
        input.prUrl ?? null,
        input.branch ?? null,
        input.workspace ?? null,
        ts,
      ],
    );
    const task = this.getTask(input.id);
    if (!task) throw new Error('Task insert failed');
    return task;
  }

  updateTask(id: string, patch: TaskPatch): TaskRecord | null {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    const assign = (column: string, value: SqlValue): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

    if (patch.status !== undefined) assign('status', patch.status);
    if (patch.engine !== undefined) assign('engine', patch.engine);
    if (patch.priority !== undefined) assign('priority', patch.priority);
    if (patch.issueNumber !== undefined) assign('issue_number', patch.issueNumber);
    if (patch.issueTitle !== undefined) assign('issue_title', patch.issueTitle);
    if (patch.prNumber !== undefined) assign('pr_number', patch.prNumber);
    if (patch.prUrl !== undefined) assign('pr_url', patch.prUrl);
    if (patch.branch !== undefined) assign('branch', patch.branch);
    if (patch.workspace !== undefined) assign('workspace', patch.workspace);
    if (patch.summary !== undefined) assign('summary', patch.summary);
    if (patch.error !== undefined) assign('error', patch.error);
    if (patch.attempts !== undefined) assign('attempts', patch.attempts);
    if (patch.startedAt !== undefined) assign('started_at', patch.startedAt);
    if (patch.finishedAt !== undefined) assign('finished_at', patch.finishedAt);
    if (patch.durationMs !== undefined) assign('duration_ms', patch.durationMs);

    if (sets.length === 0) return this.getTask(id);
    params.push(id);
    this.db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.getTask(id);
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.get<TaskDbRow>(`${TASK_SELECT} WHERE t.id = ?`, [id]);
    return row ? mapTask(row) : null;
  }

  listTasks(
    filter: { repositoryId?: string; status?: TaskStatus; limit?: number } = {},
  ): TaskRecord[] {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (filter.repositoryId) {
      clauses.push('t.repository_id = ?');
      params.push(filter.repositoryId);
    }
    if (filter.status) {
      clauses.push('t.status = ?');
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    params.push(limit);

    const rows = this.db.all<TaskDbRow>(
      `${TASK_SELECT} ${where} ORDER BY t.queued_at DESC LIMIT ?`,
      params,
    );
    return rows.map(mapTask);
  }

  listActiveTasks(): TaskRecord[] {
    const rows = this.db.all<TaskDbRow>(
      `${TASK_SELECT} WHERE t.status IN ('queued', 'running') ORDER BY t.queued_at ASC`,
    );
    return rows.map(mapTask);
  }

  findOpenTask(
    repositoryId: string,
    kind: TaskKind,
    issueNumber: number | null,
  ): TaskRecord | null {
    const row = this.db.get<TaskDbRow>(
      `${TASK_SELECT} WHERE t.repository_id = ? AND t.kind = ? AND t.status IN ('queued', 'running')
         AND (t.issue_number = ? OR (? IS NULL AND t.issue_number IS NULL))
       ORDER BY t.queued_at DESC LIMIT 1`,
      [repositoryId, kind, issueNumber, issueNumber],
    );
    return row ? mapTask(row) : null;
  }

  listRecentTaskByIssue(repositoryId: string, issueNumber: number): TaskRecord[] {
    const rows = this.db.all<TaskDbRow>(
      `${TASK_SELECT} WHERE t.repository_id = ? AND t.issue_number = ? ORDER BY t.queued_at DESC LIMIT 20`,
      [repositoryId, issueNumber],
    );
    return rows.map(mapTask);
  }

  // ------------------------------------------------------------------- logs

  appendLog(taskId: string, stream: LogStream, message: string, ts = nowIso()): TaskLogLine {
    const result = this.db.run(
      'INSERT INTO task_logs (task_id, ts, stream, message) VALUES (?, ?, ?, ?)',
      [taskId, ts, stream, message],
    );
    return { id: result.lastInsertRowid, taskId, ts, stream, message };
  }

  listLogs(taskId: string, limit = 400): TaskLogLine[] {
    const rows = this.db.all<{
      id: number;
      task_id: string;
      ts: string;
      stream: string;
      message: string;
    }>(`SELECT * FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT ?`, [
      taskId,
      Math.min(Math.max(limit, 1), 5000),
    ]);
    return rows
      .map((row) => ({
        id: row.id,
        taskId: row.task_id,
        ts: row.ts,
        stream: row.stream as LogStream,
        message: row.message,
      }))
      .reverse();
  }

  pruneLogs(taskId: string, keep = 2000): void {
    this.db.run(
      `DELETE FROM task_logs WHERE task_id = ? AND id NOT IN (
         SELECT id FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT ?
       )`,
      [taskId, taskId, keep],
    );
  }

  // --------------------------------------------------------------- activity

  addActivity(input: {
    level: ActivityEntry['level'];
    scope: string;
    repositoryId: string | null;
    message: string;
  }): ActivityEntry {
    const ts = nowIso();
    const result = this.db.run(
      'INSERT INTO activity (ts, level, scope, repository_id, message) VALUES (?, ?, ?, ?, ?)',
      [ts, input.level, input.scope, input.repositoryId, input.message],
    );
    return {
      id: result.lastInsertRowid,
      ts,
      level: input.level,
      scope: input.scope,
      repositoryId: input.repositoryId,
      repositoryFullName: null,
      message: input.message,
    };
  }

  listActivity(limit = 80): ActivityEntry[] {
    const rows = this.db.all<{
      id: number;
      ts: string;
      level: string;
      scope: string;
      repository_id: string | null;
      repository_full_name: string | null;
      message: string;
    }>(
      `SELECT a.*, r.full_name AS repository_full_name
       FROM activity a
       LEFT JOIN repositories r ON r.id = a.repository_id
       ORDER BY a.id DESC LIMIT ?`,
      [Math.min(Math.max(limit, 1), 500)],
    );
    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      level: row.level as ActivityEntry['level'],
      scope: row.scope,
      repositoryId: row.repository_id,
      repositoryFullName: row.repository_full_name,
      message: row.message,
    }));
  }

  // --------------------------------------------------------------- settings

  allSettings(): Record<string, string> {
    const rows = this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }

  setSetting(key: string, value: string): void {
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, nowIso()],
    );
  }

  setSettings(values: Record<string, string>): void {
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) this.setSetting(key, value);
    });
  }

  // ------------------------------------------------------------------ stats

  countTasksByStatus(): Record<string, number> {
    const rows = this.db.all<{ status: string; count: number }>(
      'SELECT status, COUNT(*) AS count FROM tasks GROUP BY status',
    );
    const result: Record<string, number> = {};
    for (const row of rows) result[row.status] = Number(row.count);
    return result;
  }

  countFailedTasks(
    repositoryId: string,
    kind: TaskKind,
    options: { issueNumber?: number | null; prNumber?: number | null } = {},
  ): number {
    const clauses = ['repository_id = ?', 'kind = ?', "status = 'failed'"];
    const params: SqlValue[] = [repositoryId, kind];

    if (options.issueNumber !== undefined && options.issueNumber !== null) {
      clauses.push('issue_number = ?');
      params.push(options.issueNumber);
    }
    if (options.prNumber !== undefined && options.prNumber !== null) {
      clauses.push('pr_number = ?');
      params.push(options.prNumber);
    }

    const row = this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM tasks WHERE ${clauses.join(' AND ')}`,
      params,
    );
    return Number(row?.count ?? 0);
  }

  countTrackedItems(): { issues: number; pullRequests: number } {
    const issues = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM issues WHERE state = 'open'",
    );
    const pullRequests = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM pull_requests WHERE state = 'open' AND merged = 0",
    );
    return {
      issues: Number(issues?.count ?? 0),
      pullRequests: Number(pullRequests?.count ?? 0),
    };
  }
}

function mapAccount(row: AccountDbRow): AccountRecord {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider as ProviderKind,
    baseUrl: row.base_url,
    username: row.username,
    avatarUrl: row.avatar_url,
    displayName: row.display_name,
    status: row.status as AccountStatus,
    statusMessage: row.status_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckedAt: row.last_checked_at,
    tokenPreview: null,
    repositoryCount: Number(row.repository_count ?? 0),
    tokenEnc: row.token_enc,
  };
}

function mapRepository(row: RepositoryDbRow): RepositoryRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name ?? '',
    provider: row.provider as ProviderKind,
    owner: row.owner,
    name: row.name,
    fullName: row.full_name,
    defaultBranch: row.default_branch,
    htmlUrl: row.html_url,
    cloneUrl: row.clone_url,
    private: fromBool(row.private),
    description: row.description,
    enabled: fromBool(row.enabled),
    labelsInitialized: fromBool(row.labels_initialized),
    labelSyncedAt: row.label_synced_at,
    lastPolledAt: row.last_polled_at,
    lastPollError: row.last_poll_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row: TaskDbRow): TaskRecord {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    repositoryFullName: row.repository_full_name ?? '',
    kind: row.kind as TaskKind,
    status: row.status as TaskStatus,
    engine: row.engine as EngineId,
    priority: row.priority as TaskPriority,
    issueNumber: row.issue_number,
    issueTitle: row.issue_title,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    branch: row.branch,
    workspace: row.workspace,
    summary: row.summary,
    error: row.error,
    attempts: row.attempts,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms ?? msBetween(row.started_at, row.finished_at),
  };
}
