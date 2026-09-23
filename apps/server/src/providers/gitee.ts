import type {
  Comment,
  ProviderKind,
  RemoteIssue,
  RemoteLabel,
  RemotePullRequest,
  RemoteRepositorySummary,
  RemoteUser,
} from '@autogit/shared';

import { ApiClient, ApiError, tryRequests } from './http.js';
import {
  basicAuthHeader,
  type CreateLabelInput,
  type CreatePullRequestInput,
  type CreateReviewCommentInput,
  type GitProvider,
  type LabelTargetInput,
  type ListIssueOptions,
  type ListPullRequestOptions,
  type ListRepositoryOptions,
  type ListRepositoryResult,
  normalizeBaseUrl,
  type ProviderAccount,
  type RepoRef,
} from './types.js';

interface GiteeUser {
  login?: string;
  name?: string | null;
  avatar_url: string | null;
  email?: string | null;
}

interface GiteeRepository {
  name: string;
  full_name?: string;
  path?: string;
  namespace?: { path?: string; name?: string };
  owner?: { login?: string };
  private: boolean;
  description: string | null;
  default_branch: string;
  html_url: string;
  updated_at?: string | null;
}

interface GiteeLabel {
  id?: number;
  name: string;
  color: string;
}

interface GiteeIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  labels?: Array<GiteeLabel | string>;
  user?: GiteeUser | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  comments?: number;
  pull_request?: unknown;
}

interface GiteePullRequest {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  merged_at?: string | null;
  labels?: Array<GiteeLabel | string>;
  user?: GiteeUser | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  draft?: boolean;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
}

interface GiteeComment {
  id: number;
  body: string;
  user?: GiteeUser | null;
  created_at: string;
}

interface GiteePullComment extends GiteeComment {
  path?: string | null;
  /** Diff position of the comment; Gitee sends it as a string. */
  position?: string | number | null;
  original_position?: string | number | null;
  /** Line number in the new file version, when the comment is anchored. */
  new_line?: string | number | null;
  commit_id?: string | null;
  html_url?: string | null;
}

function normalizeBaseUrlFor(raw: string): string {
  const base = normalizeBaseUrl(raw);
  if (!base) return 'https://gitee.com/api/v5';
  if (/\/api\/v\d+$/.test(base)) return base;
  return `${base}/api/v5`;
}

/** Gitee reports ids and line numbers as numbers or as strings. */
function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Best effort text of a failed request, so the caller can log why it fell back. */
function describeFailure(error: unknown): string {
  if (error instanceof ApiError) return error.detail;
  return error instanceof Error ? error.message : String(error);
}

function labelsOf(labels: Array<GiteeLabel | string> | undefined): string[] {
  if (!labels) return [];
  return labels.map((label) => (typeof label === 'string' ? label : label.name));
}

function fullNameOf(repo: GiteeRepository): string {
  if (repo.full_name) return repo.full_name;
  const owner = repo.namespace?.path ?? repo.owner?.login ?? '';
  const name = repo.path ?? repo.name;
  return owner ? `${owner}/${name}` : name;
}

export class GiteeProvider implements GitProvider {
  readonly kind: ProviderKind = 'gitee';
  readonly baseUrl: string;
  readonly proxyUrl: string | null;
  private readonly client: ApiClient;

  constructor(private readonly account: ProviderAccount) {
    this.baseUrl = normalizeBaseUrlFor(account.baseUrl);
    this.proxyUrl = account.proxyUrl ?? null;
    this.client = new ApiClient({
      baseUrl: this.baseUrl,
      // Gitee documents the `access_token` query parameter; the header is sent
      // as well so both authentication styles work.
      auth: { scheme: 'bearer', token: account.token, queryParam: 'access_token' },
      proxyUrl: this.proxyUrl,
    });
  }

  gitAuthorizationHeader(): string | null {
    const user =
      this.account.username && this.account.username.length > 0 ? this.account.username : 'oauth2';
    return basicAuthHeader(user, this.account.token);
  }

  async getCurrentUser(): Promise<RemoteUser> {
    const user = await this.client.get<GiteeUser>('/user');
    return {
      login: user.login ?? user.name ?? 'unknown',
      name: user.name ?? null,
      avatarUrl: user.avatar_url,
      email: user.email ?? null,
    };
  }

  async listRepositories(options: ListRepositoryOptions = {}): Promise<ListRepositoryResult> {
    const page = options.page ?? 1;
    const perPage = options.perPage ?? 50;
    const baseQuery: Record<string, string | number> = {
      page,
      per_page: perPage,
      sort: 'updated',
      direction: 'desc',
    };
    if (options.search && options.search.trim().length > 0) baseQuery.q = options.search.trim();

    const repos = await tryRequests([
      () =>
        this.client.get<GiteeRepository[]>('/user/repos', {
          query: { ...baseQuery, affiliation: 'owner,collaborator,organization_member' },
        }),
      () => this.client.get<GiteeRepository[]>('/user/repos', { query: baseQuery }),
    ]);

    const items = (repos ?? []).map((repo) => this.mapRepository(repo));
    return { items, page, hasMore: items.length >= perPage };
  }

  private mapRepository(repo: GiteeRepository): RemoteRepositorySummary {
    const fullName = fullNameOf(repo);
    const owner = fullName.split('/')[0] ?? '';
    return {
      owner,
      name: repo.path ?? repo.name,
      fullName,
      defaultBranch: repo.default_branch,
      htmlUrl: repo.html_url,
      cloneUrl: `${repo.html_url}.git`,
      private: repo.private,
      description: repo.description,
      updatedAt: repo.updated_at ?? null,
      imported: false,
      repositoryId: null,
    };
  }

  async getRepository(ref: RepoRef): Promise<RemoteRepositorySummary> {
    const repo = await this.client.get<GiteeRepository>(`/repos/${ref.owner}/${ref.name}`);
    return this.mapRepository(repo);
  }

  async listLabels(ref: RepoRef): Promise<RemoteLabel[]> {
    const labels = await this.client.paginate<GiteeLabel>(
      `/repos/${ref.owner}/${ref.name}/labels`,
      {
        limit: 300,
      },
    );
    return labels.map((label) => ({
      id: label.id ?? null,
      name: label.name,
      color: label.color,
      description: null,
    }));
  }

  async createLabel(ref: RepoRef, input: CreateLabelInput): Promise<RemoteLabel> {
    const label = await tryRequests<GiteeLabel>([
      () =>
        this.client.post<GiteeLabel>(`/repos/${ref.owner}/${ref.name}/labels`, {
          body: { name: input.name, color: input.color.replace('#', '') },
        }),
      () =>
        this.client.post<GiteeLabel>(`/repos/${ref.owner}/${ref.name}/labels`, {
          body: { name: input.name, color: `#${input.color.replace('#', '')}` },
        }),
    ]);
    return {
      id: label?.id ?? null,
      name: label?.name ?? input.name,
      color: label?.color ?? input.color,
      description: input.description,
    };
  }

  async updateLabel(ref: RepoRef, name: string, input: CreateLabelInput): Promise<RemoteLabel> {
    const existing = await this.listLabels(ref);
    const current = existing.find((label) => label.name === name);
    if (!current) return this.createLabel(ref, input);

    const color = input.color.replace('#', '');
    const label = await tryRequests<GiteeLabel>([
      () =>
        this.client.patch<GiteeLabel>(
          `/repos/${ref.owner}/${ref.name}/labels/${encodeURIComponent(name)}`,
          {
            body: { name: input.name, color },
          },
        ),
      () =>
        this.client.put<GiteeLabel>(
          `/repos/${ref.owner}/${ref.name}/labels/${encodeURIComponent(name)}`,
          {
            body: { name: input.name, color },
          },
        ),
      () =>
        this.client.patch<GiteeLabel>(
          `/repos/${ref.owner}/${ref.name}/labels/${encodeURIComponent(name)}`,
          {
            body: { name: input.name, color: `#${color}` },
          },
        ),
    ]);
    return {
      id: label?.id ?? current.id ?? null,
      name: label?.name ?? input.name,
      color: label?.color ?? color,
      description: input.description,
    };
  }

  async listIssues(ref: RepoRef, options: ListIssueOptions = {}): Promise<RemoteIssue[]> {
    const query: Record<string, string | number> = {
      state: options.state === 'all' ? 'all' : (options.state ?? 'open'),
      per_page: 100,
      sort: 'updated',
      direction: 'desc',
    };
    if (options.labels && options.labels.length > 0) query.labels = options.labels.join(',');
    if (options.since) query.since = options.since;

    const issues = await this.client.paginate<GiteeIssue>(
      `/repos/${ref.owner}/${ref.name}/issues`,
      {
        query,
        limit: options.limit ?? 200,
      },
    );
    return issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      state: issue.state === 'closed' ? 'closed' : 'open',
      labels: labelsOf(issue.labels),
      author: issue.user?.login ?? 'unknown',
      htmlUrl: issue.html_url,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      comments: issue.comments ?? 0,
      isPullRequest: false,
    }));
  }

  async getIssue(ref: RepoRef, number: number): Promise<RemoteIssue> {
    const issue = await this.client.get<GiteeIssue>(
      `/repos/${ref.owner}/${ref.name}/issues/${number}`,
    );
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      state: issue.state === 'closed' ? 'closed' : 'open',
      labels: labelsOf(issue.labels),
      author: issue.user?.login ?? 'unknown',
      htmlUrl: issue.html_url,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      comments: issue.comments ?? 0,
      isPullRequest: false,
    };
  }

  async listComments(ref: RepoRef, number: number): Promise<Comment[]> {
    const comments = await this.client.paginate<GiteeComment>(
      `/repos/${ref.owner}/${ref.name}/issues/${number}/comments`,
      { limit: 100 },
    );
    return comments.map((comment) => ({
      id: String(comment.id),
      author: comment.user?.login ?? 'unknown',
      body: comment.body ?? '',
      createdAt: comment.created_at,
      url: null,
    }));
  }

  async createComment(ref: RepoRef, number: number, body: string): Promise<Comment> {
    const comment = await this.client.post<GiteeComment>(
      `/repos/${ref.owner}/${ref.name}/issues/${number}/comments`,
      { body: { body } },
    );
    return {
      id: String(comment?.id ?? Date.now()),
      author: comment?.user?.login ?? 'autogit',
      body: comment?.body ?? body,
      createdAt: comment?.created_at ?? new Date().toISOString(),
      url: null,
    };
  }

  async listReviewComments(ref: RepoRef, number: number): Promise<Comment[]> {
    const path = `/repos/${ref.owner}/${ref.name}/pulls/${number}/comments`;
    // The endpoint returns conversation comments and code line comments
    // together. `comment_type` narrows it down, but older deployments reject
    // the parameter, hence the unfiltered fallback plus a path filter below.
    const comments = await tryRequests(
      [
        () =>
          this.client.paginate<GiteePullComment>(path, {
            query: { comment_type: 'diff_comment' },
            limit: 100,
          }),
        () => this.client.paginate<GiteePullComment>(path, { limit: 100 }),
      ],
      [400, 404, 422],
    );
    return comments
      .filter((comment) => (comment.path ?? '').length > 0)
      .map((comment) => ({
        id: String(comment.id),
        author: comment.user?.login ?? 'unknown',
        body: comment.body ?? '',
        createdAt: comment.created_at,
        url: comment.html_url ?? null,
        path: comment.path ?? null,
        line: toNumber(comment.new_line) ?? toNumber(comment.position),
      }));
  }

  /**
   * Gitee documents `position` as a line count inside the diff ("PR代码评论diff
   * 中的行数"), but deployments disagree on the exact numbering and some treat
   * it as the line number of the new file. Every candidate is tried - a request
   * the instance rejects moves on to the next one instead of aborting the loop -
   * and the created comment is read back: only a returned `new_line` equal to
   * the intended line counts as success. Anything else deletes the comment
   * again, so the caller keeps that finding in the summary comment instead of
   * leaving a misleading anchor behind.
   */
  async createReviewComment(
    ref: RepoRef,
    number: number,
    input: CreateReviewCommentInput,
  ): Promise<Comment> {
    const path = `/repos/${ref.owner}/${ref.name}/pulls/${number}/comments`;
    // The patch positions of the anchor come first (most likely reading first),
    // the new file line is the last resort for instances that read `position`
    // that way. Duplicates would only cost an extra request.
    const positions = [...new Set([...input.diffPositions, input.line])].filter(
      (position) => Number.isInteger(position) && position > 0,
    );
    const rejected: string[] = [];

    for (const position of positions) {
      let created: GiteePullComment | null = null;
      try {
        created = await this.client.post<GiteePullComment>(path, {
          body: {
            body: input.body,
            path: input.path,
            position,
            ...(input.commitId ? { commit_id: input.commitId } : {}),
          },
        });
      } catch (error) {
        // An instance reading `position` as a new file line rejects the patch
        // position (and vice versa); the other reading is still worth a try.
        rejected.push(`position=${position} 被拒绝（${describeFailure(error)}）`);
        continue;
      }

      const id = toNumber(created?.id);
      if (id === null) {
        rejected.push(`position=${position} 的响应里没有评论 id`);
        continue;
      }

      const verified = await this.readPullComment(ref, id);
      // Only the real new file line counts. Falling back to `position` would
      // compare a patch offset against a line number, and an instance that
      // echoes the value back would make a misplaced comment look verified.
      const line = toNumber(verified?.new_line);
      if (line === input.line) {
        return {
          id: String(id),
          author: verified?.user?.login ?? 'autogit',
          body: verified?.body ?? input.body,
          createdAt: verified?.created_at ?? new Date().toISOString(),
          url: verified?.html_url ?? null,
          path: input.path,
          line,
        };
      }

      await this.deletePullComment(ref, id);
      rejected.push(`position=${position} 落在${line === null ? '无法确认的行' : `第 ${line} 行`}`);
    }

    throw new Error(
      `Gitee 未接受这条行内评论，该条已退回汇总评论：${
        rejected.length > 0 ? rejected.join('；') : '没有可用的位置候选'
      }`,
    );
  }

  private async readPullComment(ref: RepoRef, id: number): Promise<GiteePullComment | null> {
    try {
      return await this.client.get<GiteePullComment>(
        `/repos/${ref.owner}/${ref.name}/pulls/comments/${id}`,
      );
    } catch {
      // Reading back is only a verification step; without it the anchor counts
      // as unverified and the caller falls back to the summary comment.
      return null;
    }
  }

  private async deletePullComment(ref: RepoRef, id: number): Promise<void> {
    try {
      await this.client.delete(`/repos/${ref.owner}/${ref.name}/pulls/comments/${id}`);
    } catch {
      // Best effort: an undeletable comment only leaves a stray anchor behind.
    }
  }

  async setLabels(ref: RepoRef, target: LabelTargetInput): Promise<void> {
    const path = target.isPullRequest
      ? `/repos/${ref.owner}/${ref.name}/pulls/${target.number}/labels`
      : `/repos/${ref.owner}/${ref.name}/issues/${target.number}/labels`;

    await tryRequests(
      [
        () => this.client.put(path, { body: { labels: target.labels } }),
        () =>
          this.client.put(path, {
            body: { labels: target.labels.join(',') },
          }),
        () =>
          this.client.put(`/repos/${ref.owner}/${ref.name}/issues/${target.number}/labels`, {
            body: { labels: target.labels },
          }),
      ],
      [400, 404, 405, 415, 422, 501],
    );
  }

  private mapPullRequest(pr: GiteePullRequest): RemotePullRequest {
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? '',
      state: pr.state === 'closed' ? 'closed' : 'open',
      merged: Boolean(pr.merged_at),
      mergedAt: pr.merged_at ?? null,
      labels: labelsOf(pr.labels),
      author: pr.user?.login ?? 'unknown',
      htmlUrl: pr.html_url,
      headRef: pr.head?.ref ?? '',
      baseRef: pr.base?.ref ?? '',
      headSha: pr.head?.sha ?? null,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      draft: pr.draft === true,
    };
  }

  async listPullRequests(
    ref: RepoRef,
    options: ListPullRequestOptions = {},
  ): Promise<RemotePullRequest[]> {
    const query: Record<string, string | number> = {
      state: options.state ?? 'open',
      per_page: 100,
      sort: 'updated',
      direction: 'desc',
    };
    const pulls = await this.client.paginate<GiteePullRequest>(
      `/repos/${ref.owner}/${ref.name}/pulls`,
      {
        query,
        limit: options.limit ?? 100,
      },
    );
    const mapped = pulls.map((pr) => this.mapPullRequest(pr));
    return options.headRef ? mapped.filter((pr) => pr.headRef === options.headRef) : mapped;
  }

  async getPullRequest(ref: RepoRef, number: number): Promise<RemotePullRequest> {
    const pr = await this.client.get<GiteePullRequest>(
      `/repos/${ref.owner}/${ref.name}/pulls/${number}`,
    );
    return this.mapPullRequest(pr);
  }

  async findPullRequestByHead(ref: RepoRef, headRef: string): Promise<RemotePullRequest | null> {
    const pulls = await this.listPullRequests(ref, { state: 'all', headRef, limit: 100 });
    return pulls.find((pr) => pr.headRef === headRef) ?? null;
  }

  async createPullRequest(ref: RepoRef, input: CreatePullRequestInput): Promise<RemotePullRequest> {
    const pr = await this.client.post<GiteePullRequest>(`/repos/${ref.owner}/${ref.name}/pulls`, {
      body: {
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
      },
    });
    return this.mapPullRequest(pr);
  }
}
