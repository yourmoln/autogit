import type {
  Comment,
  ProviderKind,
  RemoteIssue,
  RemoteLabel,
  RemotePullRequest,
  RemoteRepositorySummary,
  RemoteUser,
} from '@autogit/shared';
import { AI_LABEL_BY_NAME } from '@autogit/shared';

import { ApiClient } from './http.js';
import {
  basicAuthHeader,
  type CreateLabelInput,
  type CreatePullRequestInput,
  type GitProvider,
  type LabelTargetInput,
  type ListIssueOptions,
  type ListPullRequestOptions,
  type ListRepositoryOptions,
  type ListRepositoryResult,
  normalizeBaseUrl,
  type ProviderAccount,
  type RepoRef,
  type UpdatePullRequestInput,
} from './types.js';

interface GiteaUser {
  login: string;
  full_name?: string | null;
  avatar_url: string | null;
  email?: string | null;
}

interface GiteaRepository {
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch: string;
  html_url: string;
  clone_url: string;
  updated_at: string | null;
  owner: { login: string };
}

interface GiteaLabel {
  id: number;
  name: string;
  color: string;
  description?: string | null;
}

interface GiteaIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  labels?: GiteaLabel[];
  user?: GiteaUser | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  comments?: number;
  pull_request?: unknown;
}

interface GiteaPullRequest {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  labels?: GiteaLabel[];
  user?: GiteaUser | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  draft?: boolean;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
}

interface GiteaComment {
  id: number;
  body: string;
  user?: GiteaUser | null;
  created_at: string;
  html_url?: string;
}

function normalizeBaseUrlFor(raw: string): string {
  const base = normalizeBaseUrl(raw);
  if (!base) return 'http://127.0.0.1:3000/api/v1';
  if (/\/api\/v1$/.test(base)) return base;
  return `${base}/api/v1`;
}

/** Gitea reports label ids as numbers, but the shared label type also allows strings. */
function toNumericId(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export class GiteaProvider implements GitProvider {
  readonly kind: ProviderKind = 'gitea';
  readonly baseUrl: string;
  readonly proxyUrl: string | null;
  private readonly client: ApiClient;

  constructor(private readonly account: ProviderAccount) {
    this.baseUrl = normalizeBaseUrlFor(account.baseUrl);
    this.proxyUrl = account.proxyUrl ?? null;
    this.client = new ApiClient({
      baseUrl: this.baseUrl,
      auth: { scheme: 'token', token: account.token },
      headers: { Accept: 'application/json' },
      proxyUrl: this.proxyUrl,
    });
  }

  gitAuthorizationHeader(): string | null {
    const user =
      this.account.username && this.account.username.length > 0 ? this.account.username : 'oauth2';
    return basicAuthHeader(user, this.account.token);
  }

  async getCurrentUser(): Promise<RemoteUser> {
    const user = await this.client.get<GiteaUser>('/user');
    return {
      login: user.login,
      name: user.full_name ?? null,
      avatarUrl: user.avatar_url,
      email: user.email ?? null,
    };
  }

  async listRepositories(options: ListRepositoryOptions = {}): Promise<ListRepositoryResult> {
    const page = options.page ?? 1;
    const perPage = options.perPage ?? 50;
    const query: Record<string, string | number> = {
      page,
      limit: perPage,
      sort: 'updated',
      order: 'desc',
    };
    if (options.search && options.search.trim().length > 0) {
      query.q = options.search.trim();
      const result = await this.client.get<{ data: GiteaRepository[] }>('/repos/search', {
        query: { ...query, limit: perPage },
      });
      const repos = result.data ?? [];
      return {
        items: repos.map((repo) => this.mapRepository(repo)),
        page,
        hasMore: repos.length >= perPage,
      };
    }

    const repos = await this.client.get<GiteaRepository[]>('/user/repos', { query });
    return {
      items: repos.map((repo) => this.mapRepository(repo)),
      page,
      hasMore: repos.length >= perPage,
    };
  }

  private mapRepository(repo: GiteaRepository): RemoteRepositorySummary {
    return {
      owner: repo.owner?.login ?? repo.full_name.split('/')[0] ?? '',
      name: repo.name,
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      htmlUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      private: repo.private,
      description: repo.description,
      updatedAt: repo.updated_at,
      imported: false,
      repositoryId: null,
    };
  }

  async getRepository(ref: RepoRef): Promise<RemoteRepositorySummary> {
    const repo = await this.client.get<GiteaRepository>(`/repos/${ref.owner}/${ref.name}`);
    return this.mapRepository(repo);
  }

  async listLabels(ref: RepoRef): Promise<RemoteLabel[]> {
    const labels = await this.client.paginate<GiteaLabel>(
      `/repos/${ref.owner}/${ref.name}/labels`,
      {
        perPageParam: 'limit',
        limit: 300,
      },
    );
    return labels.map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color,
      description: label.description ?? null,
    }));
  }

  async createLabel(ref: RepoRef, input: CreateLabelInput): Promise<RemoteLabel> {
    const label = await this.client.post<GiteaLabel>(`/repos/${ref.owner}/${ref.name}/labels`, {
      body: {
        name: input.name,
        color: `#${input.color.replace('#', '')}`,
        description: input.description,
        exclusive: input.exclusive ?? false,
      },
    });
    return {
      id: label.id,
      name: label.name,
      color: label.color,
      description: label.description ?? input.description,
    };
  }

  async updateLabel(ref: RepoRef, name: string, input: CreateLabelInput): Promise<RemoteLabel> {
    const existing = await this.listLabels(ref);
    const current = existing.find((label) => label.name === name);
    if (!current || current.id === null) {
      return this.createLabel(ref, input);
    }
    const label = await this.client.patch<GiteaLabel>(
      `/repos/${ref.owner}/${ref.name}/labels/${current.id}`,
      {
        body: {
          name: input.name,
          color: `#${input.color.replace('#', '')}`,
          description: input.description,
          exclusive: input.exclusive ?? false,
        },
      },
    );
    return {
      id: label.id,
      name: label.name,
      color: label.color,
      description: label.description ?? input.description,
    };
  }

  async listIssues(ref: RepoRef, options: ListIssueOptions = {}): Promise<RemoteIssue[]> {
    const query: Record<string, string | number> = {
      state: options.state === 'all' ? 'all' : (options.state ?? 'open'),
      sort: 'updated',
      limit: 50,
    };
    if (options.labels && options.labels.length > 0) query.labels = options.labels.join(',');
    if (options.since) query.since = options.since;

    const issues = await this.client.paginate<GiteaIssue>(
      `/repos/${ref.owner}/${ref.name}/issues`,
      {
        query,
        perPageParam: 'limit',
        limit: options.limit ?? 200,
      },
    );
    return issues
      .filter((issue) => issue.pull_request === undefined || issue.pull_request === null)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? '',
        state: issue.state === 'closed' ? 'closed' : 'open',
        labels: (issue.labels ?? []).map((label) => label.name),
        author: issue.user?.login ?? 'unknown',
        htmlUrl: issue.html_url,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        comments: issue.comments ?? 0,
        isPullRequest: false,
      }));
  }

  async getIssue(ref: RepoRef, number: number): Promise<RemoteIssue> {
    const issue = await this.client.get<GiteaIssue>(
      `/repos/${ref.owner}/${ref.name}/issues/${number}`,
    );
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      state: issue.state === 'closed' ? 'closed' : 'open',
      labels: (issue.labels ?? []).map((label) => label.name),
      author: issue.user?.login ?? 'unknown',
      htmlUrl: issue.html_url,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      comments: issue.comments ?? 0,
      isPullRequest: issue.pull_request !== undefined && issue.pull_request !== null,
    };
  }

  async listComments(ref: RepoRef, number: number): Promise<Comment[]> {
    const comments = await this.client.paginate<GiteaComment>(
      `/repos/${ref.owner}/${ref.name}/issues/${number}/comments`,
      { perPageParam: 'limit', limit: 100 },
    );
    return comments.map((comment) => ({
      id: String(comment.id),
      author: comment.user?.login ?? 'unknown',
      body: comment.body ?? '',
      createdAt: comment.created_at,
      url: comment.html_url ?? null,
    }));
  }

  async createComment(ref: RepoRef, number: number, body: string): Promise<Comment> {
    const comment = await this.client.post<GiteaComment>(
      `/repos/${ref.owner}/${ref.name}/issues/${number}/comments`,
      { body: { body } },
    );
    return {
      id: String(comment.id),
      author: comment.user?.login ?? 'autogit',
      body: comment.body ?? body,
      createdAt: comment.created_at,
      url: comment.html_url ?? null,
    };
  }

  async setLabels(ref: RepoRef, target: LabelTargetInput): Promise<void> {
    const labels = await this.resolveLabelIds(ref, target.labels);
    await this.client.put(`/repos/${ref.owner}/${ref.name}/issues/${target.number}/labels`, {
      body: { labels },
    });
  }

  /**
   * Gitea's issue/PR label endpoint only accepts numeric label ids
   * (`IssueLabelsOption.labels` is `[]int64`), unlike GitHub which takes names.
   * Names are therefore resolved against the repository catalogue first;
   * unknown names are created on the fly so a label transition never fails just
   * because a label is missing from the catalogue.
   */
  private async resolveLabelIds(ref: RepoRef, names: readonly string[]): Promise<number[]> {
    const wanted = [...new Set(names)];
    if (wanted.length === 0) return [];

    const existing = await this.listLabels(ref);
    const idByName = new Map<string, number>();
    for (const label of existing) {
      const id = toNumericId(label.id);
      if (id !== null) idByName.set(label.name, id);
    }

    const ids: number[] = [];
    for (const name of wanted) {
      const known = idByName.get(name);
      if (known !== undefined) {
        ids.push(known);
        continue;
      }

      const definition = AI_LABEL_BY_NAME[name];
      const created = await this.createLabel(ref, {
        name,
        color: definition?.color ?? 'ededed',
        description: definition?.description ?? '',
        exclusive: definition?.exclusiveGroup !== undefined,
      });
      const createdId = toNumericId(created.id);
      if (createdId !== null) {
        idByName.set(name, createdId);
        ids.push(createdId);
      }
    }

    return ids;
  }

  private mapPullRequest(pr: GiteaPullRequest): RemotePullRequest {
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? '',
      state: pr.state === 'closed' ? 'closed' : 'open',
      merged: pr.merged === true || Boolean(pr.merged_at),
      mergedAt: pr.merged_at ?? null,
      labels: (pr.labels ?? []).map((label) => label.name),
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
      sort: 'updated',
      limit: 50,
    };
    const pulls = await this.client.paginate<GiteaPullRequest>(
      `/repos/${ref.owner}/${ref.name}/pulls`,
      { query, perPageParam: 'limit', limit: options.limit ?? 100 },
    );
    const mapped = pulls.map((pr) => this.mapPullRequest(pr));
    return options.headRef ? mapped.filter((pr) => pr.headRef === options.headRef) : mapped;
  }

  async getPullRequest(ref: RepoRef, number: number): Promise<RemotePullRequest> {
    const pr = await this.client.get<GiteaPullRequest>(
      `/repos/${ref.owner}/${ref.name}/pulls/${number}`,
    );
    return this.mapPullRequest(pr);
  }

  async findPullRequestByHead(ref: RepoRef, headRef: string): Promise<RemotePullRequest | null> {
    const pulls = await this.listPullRequests(ref, { state: 'all', headRef, limit: 100 });
    return pulls.find((pr) => pr.headRef === headRef) ?? null;
  }

  async createPullRequest(ref: RepoRef, input: CreatePullRequestInput): Promise<RemotePullRequest> {
    const pr = await this.client.post<GiteaPullRequest>(`/repos/${ref.owner}/${ref.name}/pulls`, {
      body: {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
      },
    });
    return this.mapPullRequest(pr);
  }

  /**
   * Rewrites the title and/or body of an existing PR. Gitea uses the same
   * endpoint as creation, so only the supplied fields are sent (`undefined`
   * keys are dropped by the JSON serialiser).
   */
  async updatePullRequest(
    ref: RepoRef,
    number: number,
    input: UpdatePullRequestInput,
  ): Promise<RemotePullRequest> {
    const pr = await this.client.patch<GiteaPullRequest>(
      `/repos/${ref.owner}/${ref.name}/pulls/${number}`,
      { body: { ...input } },
    );
    return this.mapPullRequest(pr);
  }
}
