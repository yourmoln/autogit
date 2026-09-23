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

/**
 * One inline (line level) review comment.
 *
 * Platforms disagree on how a line is addressed: GitHub takes the line number
 * of the new file version, Gitea the same number under a misleading
 * `new_position` field, and Gitee a position inside the patch. `diffPosition`
 * therefore travels next to `line` so a provider can use whichever one it
 * needs without re-parsing the diff.
 */
export interface CreateReviewCommentInput {
  body: string;
  /** Repository relative path of the commented file, without `a/` or `b/`. */
  path: string;
  /** Line number in the new version of the file. */
  line: number;
  /** 1-based index of that line in the raw diff of the file. */
  diffPosition: number;
  /** Head commit the comment should be anchored to, when the platform wants it. */
  commitId: string | null;
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
  /** Inline review comments (`path` / `line` filled in); `[]` when unsupported. */
  listReviewComments(ref: RepoRef, number: number): Promise<Comment[]>;
  createReviewComment(
    ref: RepoRef,
    number: number,
    input: CreateReviewCommentInput,
  ): Promise<Comment>;
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
