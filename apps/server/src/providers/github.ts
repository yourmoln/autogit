import type {
  Comment,
  ProviderKind,
  RemoteIssue,
  RemoteLabel,
  RemotePullRequest,
  RemoteRepositorySummary,
  RemoteUser,
} from '@autogit/shared';

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
} from './types.js';

const ACCEPT = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';

interface GitHubUser {
  login: string;
  name: string | null;
  avatar_url: string | null;
  email: string | null;
}

interface GitHubRepository {
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

interface GitHubLabel {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<GitHubLabel | string>;
  user: { login: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  comments: number;
  pull_request?: unknown;
}

interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged?: boolean;
  merged_at: string | null;
  labels: Array<GitHubLabel | string>;
  user: { login: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
}

interface GitHubComment {
  id: number;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
  html_url: string;
}

function normalizeBaseUrlFor(rawBaseUrl: string): string {
  const base = normalizeBaseUrl(rawBaseUrl);
  if (!base) return 'https://api.github.com';
  const url = new URL(base);
  if (url.pathname === '/' || url.pathname === '') {
    if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
      return 'https://api.github.com';
    }
    return `${base}/api/v3`;
  }
  return base;
}

function labelNames(labels: Array<GitHubLabel | string> | undefined): string[] {
  if (!labels) return [];
  return labels.map((label) => (typeof label === 'string' ? label : label.name));
}

export class GitHubProvider implements GitProvider {
  readonly kind: ProviderKind = 'github';
  readonly baseUrl: string;
  private readonly client: ApiClient;

  constructor(private readonly account: ProviderAccount) {
    this.baseUrl = normalizeBaseUrlFor(account.baseUrl);
    this.client = new ApiClient({
      baseUrl: this.baseUrl,
      auth: { scheme: 'bearer', token: account.token },
      headers: { 'X-GitHub-Api-Version': API_VERSION },
    });
  }

  gitAuthorizationHeader(): string | null {
    return basicAuthHeader('x-access-token', this.account.token);
  }

  async getCurrentUser(): Promise<RemoteUser> {
    const user = await this.client.get<GitHubUser>('/user', { accept: ACCEPT });
    return { login: user.login, name: user.name, avatarUrl: user.avatar_url, email: user.email };
  }

  async listRepositories(options: ListRepositoryOptions = {}): Promise<ListRepositoryResult> {
    const page = options.page ?? 1;
    const perPage = options.perPage ?? 50;
    const query: Record<string, string | number> = {
      sort: 'updated',
      direction: 'desc',
      page,
      per_page: perPage,
    };

    if (options.search && options.search.trim().length > 0) {
      const term = options.search.trim();
      const result = await this.client.get<{ items: GitHubRepository[] }>('/search/repositories', {
        query: { q: term.includes('/') ? term : `${term} in:name`, per_page: perPage, page },
        accept: ACCEPT,
      });
      const items = (result.items ?? []).map((repo) => this.mapRepository(repo));
      return { items, page, hasMore: items.length >= perPage };
    }

    query.affiliation = 'owner,collaborator,organization_member';
    const repos = await this.client.get<GitHubRepository[]>('/user/repos', {
      query,
      accept: ACCEPT,
    });
    const items = repos.map((repo) => this.mapRepository(repo));
    return { items, page, hasMore: repos.length >= perPage };
  }

  private mapRepository(repo: GitHubRepository): RemoteRepositorySummary {
    return {
      owner: repo.owner.login,
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
    const repo = await this.client.get<GitHubRepository>(`/repos/${ref.owner}/${ref.name}`, {
      accept: ACCEPT,
    });
    return this.mapRepository(repo);
  }

  async listLabels(ref: RepoRef): Promise<RemoteLabel[]> {
    const labels = await this.client.paginate<GitHubLabel>(
      `/repos/${ref.owner}/${ref.name}/labels`,
      {
        limit: 300,
        accept: ACCEPT,
      },
    );
    return labels.map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color,
      description: label.description,
    }));
  }

  async createLabel(ref: RepoRef, input: CreateLabelInput): Promise<RemoteLabel> {
    const label = await this.client.post<GitHubLabel>(`/repos/${ref.owner}/${ref.name}/labels`, {
      body: {
        name: input.name,
        color: input.color.replace('#', ''),
        description: input.description,
      },
      accept: ACCEPT,
    });
    return { id: label.id, name: label.name, color: label.color, description: label.description };
  }

  async updateLabel(ref: RepoRef, name: string, input: CreateLabelInput): Promise<RemoteLabel> {
    const label = await this.client.patch<GitHubLabel>(
      `/repos/${ref.owner}/${ref.name}/labels/${encodeURIComponent(name)}`,
      {
        body: {
          new_name: input.name,
          color: input.color.replace('#', ''),
          description: input.description,
        },
        accept: ACCEPT,
      },
    );
    return { id: label.id, name: label.name, color: label.color, description: label.description };
  }

  async listIssues(ref: RepoRef, options: ListIssueOptions = {}): Promise<RemoteIssue[]> {
    const state = options.state ?? 'open';
    const query: Record<string, string | number> = {
      state,
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    };
    if (options.labels && options.labels.length > 0) query.labels = options.labels.join(',');
    if (options.since) query.since = options.since;

    const issues = await this.client.paginate<GitHubIssue>(
      `/repos/${ref.owner}/${ref.name}/issues`,
      { query, limit: options.limit ?? 200, accept: ACCEPT },
    );
    return issues
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => this.mapIssue(issue));
  }

  private mapIssue(issue: GitHubIssue): RemoteIssue {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      state: issue.state === 'closed' ? 'closed' : 'open',
      labels: labelNames(issue.labels),
      author: issue.user?.login ?? 'unknown',
      htmlUrl: issue.html_url,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      comments: issue.comments,
      isPullRequest: false,
    };
  }

  async getIssue(ref: RepoRef, number: number): Promise<RemoteIssue> {
    const issue = await this.client.get<GitHubIssue>(
      `/repos/${ref.owner}/${ref.name}/issues/${number}`,
      { accept: ACCEPT },
    );
    return { ...this.mapIssue(issue), isPullRequest: issue.pull_request !== undefined };
  }

  async listComments(ref: RepoRef, number: number): Promise<Comment[]> {
    const comments = await this.client.paginate<GitHubComment>(
      `/repos/${ref.owner}/${ref.name}/issues/${number}/comments`,
      { limit: 100, accept: ACCEPT },
    );
    return comments.map((comment) => ({
      id: String(comment.id),
      author: comment.user?.login ?? 'unknown',
      body: comment.body ?? '',
      createdAt: comment.created_at,
      url: comment.html_url,
    }));
  }

  async createComment(ref: RepoRef, number: number, body: string): Promise<Comment> {
    const comment = await this.client.post<GitHubComment>(
      `/repos/${ref.owner}/${ref.name}/issues/${number}/comments`,
      { body: { body }, accept: ACCEPT },
    );
    return {
      id: String(comment.id),
      author: comment.user?.login ?? 'autogit',
      body: comment.body ?? body,
      createdAt: comment.created_at,
      url: comment.html_url,
    };
  }

  async setLabels(ref: RepoRef, target: LabelTargetInput): Promise<void> {
    await this.client.put(`/repos/${ref.owner}/${ref.name}/issues/${target.number}/labels`, {
      body: { labels: target.labels },
      accept: ACCEPT,
    });
  }

  private mapPullRequest(pr: GitHubPullRequest): RemotePullRequest {
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? '',
      state: pr.state === 'closed' ? 'closed' : 'open',
      merged: pr.merged === true || pr.merged_at !== null,
      mergedAt: pr.merged_at,
      labels: labelNames(pr.labels),
      author: pr.user?.login ?? 'unknown',
      htmlUrl: pr.html_url,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      headSha: pr.head.sha ?? null,
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
      direction: 'desc',
      per_page: 100,
    };
    if (options.headRef) query.head = `${ref.owner}:${options.headRef}`;

    const pulls = await this.client.paginate<GitHubPullRequest>(
      `/repos/${ref.owner}/${ref.name}/pulls`,
      { query, limit: options.limit ?? 100, accept: ACCEPT },
    );
    return pulls.map((pr) => this.mapPullRequest(pr));
  }

  async getPullRequest(ref: RepoRef, number: number): Promise<RemotePullRequest> {
    const pr = await this.client.get<GitHubPullRequest>(
      `/repos/${ref.owner}/${ref.name}/pulls/${number}`,
      { accept: ACCEPT },
    );
    return this.mapPullRequest(pr);
  }

  async findPullRequestByHead(ref: RepoRef, headRef: string): Promise<RemotePullRequest | null> {
    const pulls = await this.listPullRequests(ref, { state: 'all', headRef, limit: 20 });
    return pulls[0] ?? null;
  }

  async createPullRequest(ref: RepoRef, input: CreatePullRequestInput): Promise<RemotePullRequest> {
    const pr = await this.client.post<GitHubPullRequest>(`/repos/${ref.owner}/${ref.name}/pulls`, {
      body: {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft ?? false,
      },
      accept: ACCEPT,
    });
    return this.mapPullRequest(pr);
  }
}
