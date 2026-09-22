import { describeNetworkError, requestText } from '../util/http-request.js';

export type AuthScheme = 'bearer' | 'token' | 'basic';

export interface AuthConfig {
  scheme: AuthScheme;
  token: string;
  username?: string | null;
  /** Some APIs (Gitee) accept the token as a query parameter instead of a header. */
  queryParam?: string | null;
}

export interface ApiClientOptions {
  baseUrl: string;
  auth: AuthConfig;
  userAgent?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Proxy resolved for the owning account, `null` means direct. */
  proxyUrl?: string | null;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  accept?: string;
  timeoutMs?: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body: string, message?: string) {
    super(message ?? `HTTP ${status} ${url}`);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
    this.body = body;
  }

  /** Best effort extraction of the provider supplied error description. */
  get detail(): string {
    const trimmed = this.body.trim();
    if (!trimmed) return `HTTP ${this.status}`;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const candidates = [
        parsed.message,
        parsed.error_description,
        parsed.error,
        parsed.errors,
        parsed.detail,
      ];
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
        if (candidate && typeof candidate === 'object') return JSON.stringify(candidate);
      }
    } catch {
      // not JSON, fall through to the raw body
    }
    return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
  }
}

const DEFAULT_TIMEOUT = 30_000;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  private buildUrl(path: string, query: RequestOptions['query'] = {}, withToken = true): string {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${base}${normalizedPath}`);

    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    const queryParam = this.options.auth.queryParam;
    if (withToken && queryParam && !url.searchParams.has(queryParam)) {
      url.searchParams.set(queryParam, this.options.auth.token);
    }
    return url.toString();
  }

  private buildHeaders(extra?: Record<string, string>, accept?: string): Record<string, string> {
    const { auth } = this.options;
    const headers: Record<string, string> = {
      Accept: accept ?? 'application/json',
      'User-Agent': this.options.userAgent ?? 'autogit/0.1',
      ...this.options.headers,
      ...extra,
    };

    switch (auth.scheme) {
      case 'bearer':
        headers.Authorization = `Bearer ${auth.token}`;
        break;
      case 'token':
        headers.Authorization = `token ${auth.token}`;
        break;
      case 'basic': {
        const user = auth.username && auth.username.length > 0 ? auth.username : 'oauth2';
        const encoded = Buffer.from(`${user}:${auth.token}`, 'utf8').toString('base64');
        headers.Authorization = `Basic ${encoded}`;
        break;
      }
      default:
        break;
    }
    return headers;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers = this.buildHeaders(options.headers, options.accept);
    const timeout = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT;
    const body =
      options.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body);
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await requestText({
          url,
          method,
          headers,
          body: body ?? null,
          timeoutMs: timeout,
          proxyUrl: this.options.proxyUrl ?? null,
        });

        if (RETRY_STATUS.has(response.status) && attempt < 2) {
          const retryAfter = Number(response.headers['retry-after'] ?? '0');
          const waitMs = retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 500 * (attempt + 1);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }

        const text = response.body;
        if (response.status < 200 || response.status >= 300) {
          throw new ApiError(response.status, url, text);
        }
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      } catch (error) {
        lastError = error;
        if (error instanceof ApiError) throw error;
        if (attempt >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
    throw new Error(`请求失败：${describeNetworkError(lastError, timeout)} (${url})`);
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, options);
  }

  put<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PUT', path, options);
  }

  patch<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PATCH', path, options);
  }

  delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }

  /**
   * Page based pagination shared by GitHub/Gitea/Gitee. Stops early when the
   * provider returns a short page, or when `limit` entries were collected.
   */
  async paginate<T>(
    path: string,
    options: {
      query?: Record<string, string | number | boolean | null | undefined>;
      perPageParam?: string;
      perPage?: number;
      limit?: number;
      accept?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T[]> {
    const perPageParam = options.perPageParam ?? 'per_page';
    const perPage = options.perPage ?? 50;
    const limit = options.limit ?? 200;
    const items: T[] = [];

    for (let page = 1; page <= 20; page += 1) {
      const chunk = await this.get<T[]>(path, {
        query: { ...(options.query ?? {}), page, [perPageParam]: perPage },
        accept: options.accept,
        headers: options.headers,
      });
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      items.push(...chunk);
      if (chunk.length < perPage || items.length >= limit) break;
    }
    return items.slice(0, limit);
  }
}

export function isApiError(error: unknown, statuses: number[] = []): boolean {
  return error instanceof ApiError && (statuses.length === 0 || statuses.includes(error.status));
}

export async function tryRequests<T>(
  attempts: Array<() => Promise<T>>,
  retryStatuses: number[] = [400, 404, 405, 415, 422, 501],
): Promise<T> {
  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (!isApiError(error, retryStatuses)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
