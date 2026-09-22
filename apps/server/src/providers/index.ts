import type { ProviderKind } from '@autogit/shared';

import { GiteaProvider } from './gitea.js';
import { GiteeProvider } from './gitee.js';
import { GitHubProvider } from './github.js';
import type { GitProvider, ProviderAccount } from './types.js';

export function createProvider(account: ProviderAccount): GitProvider {
  switch (account.provider) {
    case 'github':
      return new GitHubProvider(account);
    case 'gitea':
      return new GiteaProvider(account);
    case 'gitee':
      return new GiteeProvider(account);
    default: {
      const exhaustive: never = account.provider;
      throw new Error(`不支持的 Git 平台：${String(exhaustive)}`);
    }
  }
}

export function isSupportedProvider(value: string): value is ProviderKind {
  return value === 'github' || value === 'gitea' || value === 'gitee';
}

export { ApiError } from './http.js';
export * from './types.js';
