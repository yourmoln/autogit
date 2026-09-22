import type { ProviderKind, ResolvedProxySummary } from '@autogit/shared';
import type { AccountRecord, Store } from '../db/store.js';
import type { GitProvider } from '../providers/index.js';
import { ApiError, createProvider } from '../providers/index.js';
import { decryptSecret, encryptSecret } from '../util/crypto.js';

export interface ConnectionInput {
  provider: ProviderKind;
  baseUrl: string;
  username: string | null;
  token: string;
  proxyUrl?: string | null;
}

/** Resolves the proxy an account has to use; implemented by `ProxyService`. */
export interface ProxyResolver {
  resolveForAccount(account: AccountRecord): { url: string | null; summary: ResolvedProxySummary };
}

/**
 * Creates provider clients on demand and caches them per account so repeated
 * orchestrator ticks reuse the same HTTP client.
 */
export class ProviderFactory {
  private readonly cache = new Map<string, GitProvider>();

  constructor(
    private readonly store: Store,
    private readonly secretKey: Buffer,
    private readonly proxy: ProxyResolver,
  ) {}

  create(input: ConnectionInput): GitProvider {
    return createProvider({
      provider: input.provider,
      baseUrl: input.baseUrl,
      username: input.username,
      token: input.token,
      proxyUrl: input.proxyUrl ?? null,
    });
  }

  tokenFor(accountId: string): string {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error(`账号不存在：${accountId}`);
    return this.decrypt(account.tokenEnc);
  }

  encrypt(plain: string): string {
    return encryptSecret(plain, this.secretKey);
  }

  decrypt(payload: string): string {
    return decryptSecret(payload, this.secretKey);
  }

  forAccount(accountId: string): GitProvider {
    const cached = this.cache.get(accountId);
    if (cached) return cached;

    const account = this.store.getAccount(accountId);
    if (!account) throw new Error(`账号不存在：${accountId}`);

    const provider = this.create({
      provider: account.provider,
      baseUrl: account.baseUrl,
      username: account.username,
      token: this.decrypt(account.tokenEnc),
      proxyUrl: this.proxy.resolveForAccount(account).url,
    });
    this.cache.set(accountId, provider);
    return provider;
  }

  forRepository(repositoryId: string): GitProvider {
    const repository = this.store.getRepository(repositoryId);
    if (!repository) throw new Error(`仓库不存在：${repositoryId}`);
    return this.forAccount(repository.accountId);
  }

  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }

  clear(): void {
    this.cache.clear();
  }
}

export function describeProviderError(error: unknown): string {
  if (error instanceof ApiError) {
    const hints: string[] = [`HTTP ${error.status}`];
    if (error.status === 401) hints.push('凭证无效或已过期');
    if (error.status === 403) hints.push('权限不足或触发了限流');
    if (error.status === 404) hints.push('资源不存在，或 token 缺少该仓库的访问权限');
    if (error.status === 422) hints.push('请求被仓库平台拒绝');
    return `${hints.join('：')}（${error.detail}）`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
