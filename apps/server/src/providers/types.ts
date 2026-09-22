import type {
  Comment,
  ProviderKind,
  RemoteIssue,
  RemoteLabel,
  RemotePullRequest,
  RemoteRepositorySummary,
  RemoteUser,
} from '@autogit/shared';

export interface RepoRef {
  owner: string;
  name: string;
}

export interface ProviderAccount {
  provider: ProviderKind;
  baseUrl: string;
  username: string | null;
  token: string;
  /** Proxy address resolved for this account, `null` means direct. */
  proxyUrl?: string | null;
}

export interface ListRepositoryOptions {
  page?: number;
  perPage?: number;
  search?: string;
}

export interface ListRepositoryResult {
  items: RemoteRepositorySummary[];
  page: number;
  hasMore: boolean;
}

export interface ListIssueOptions {
  state?: 'open' | 'closed' | 'all';
  labels?: string[];
  limit?: number;
  /** Only return issues updated after this ISO timestamp (best effort). */
  since?: string | null;
}

export interface ListPullRequestOptions {
  state?: 'open' | 'closed' | 'all';
  limit?: number;
  headRef?: string | null;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

export interface CreateLabelInput {
  name: string;
  color: string;
  description: string;
  /** Gitea supports mutually exclusive labels; other providers ignore this. */
  exclusive?: boolean;
}

export interface LabelTargetInput {
  number: number;
  labels: string[];
  isPullRequest: boolean;
}

export interface GitProvider {
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  /** Proxy used by git / REST calls of this account, `null` means direct. */
  readonly proxyUrl: string | null;

  getCurrentUser(): Promise<RemoteUser>;
  listRepositories(options?: ListRepositoryOptions): Promise<ListRepositoryResult>;
  getRepository(ref: RepoRef): Promise<RemoteRepositorySummary>;

  listLabels(ref: RepoRef): Promise<RemoteLabel[]>;
  createLabel(ref: RepoRef, input: CreateLabelInput): Promise<RemoteLabel>;
  updateLabel(ref: RepoRef, name: string, input: CreateLabelInput): Promise<RemoteLabel>;

  listIssues(ref: RepoRef, options?: ListIssueOptions): Promise<RemoteIssue[]>;
  getIssue(ref: RepoRef, number: number): Promise<RemoteIssue>;
  listComments(ref: RepoRef, number: number): Promise<Comment[]>;
  createComment(ref: RepoRef, number: number, body: string): Promise<Comment>;
  setLabels(ref: RepoRef, target: LabelTargetInput): Promise<void>;

  listPullRequests(ref: RepoRef, options?: ListPullRequestOptions): Promise<RemotePullRequest[]>;
  getPullRequest(ref: RepoRef, number: number): Promise<RemotePullRequest>;
  findPullRequestByHead(ref: RepoRef, headRef: string): Promise<RemotePullRequest | null>;
  createPullRequest(ref: RepoRef, input: CreatePullRequestInput): Promise<RemotePullRequest>;

  /** Value for `git -c http.extraHeader=<value>`, or null when unsupported. */
  gitAuthorizationHeader(): string | null;
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}
