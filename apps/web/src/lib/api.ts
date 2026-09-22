import type {
  Account,
  ActivityEntry,
  AppSettings,
  CodexConfigPayload,
  CodexInstallState,
  CodexModelProbe,
  CodexStatus,
  LabelPreviewRow,
  LabelSyncResult,
  OrchestratorStatus,
  ProviderKind,
  ProxyConfigPayload,
  ProxySettings,
  ProxySlot,
  ProxyTestReport,
  RemoteRepositorySummary,
  Repository,
  RepositoryOverview,
  Task,
  TaskLogLine,
  TaskStatus,
} from '@autogit/shared';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `请求失败（HTTP ${response.status}）`;
    throw new ApiRequestError(response.status, message);
  }
  return payload as T;
}

export interface OverviewPayload {
  stats: {
    accounts: number;
    repositories: number;
    enabledRepositories: number;
    labelsInitialized: number;
    trackedIssues: number;
    trackedPullRequests: number;
    tasks: Record<string, number>;
  };
  orchestrator: OrchestratorStatus;
  repositories: Array<{
    id: string;
    fullName: string;
    provider: ProviderKind;
    enabled: boolean;
    labelsInitialized: boolean;
    lastPolledAt: string | null;
    lastPollError: string | null;
  }>;
  activity: ActivityEntry[];
  realtimeClients: number;
}

export interface RepositoryListItem extends Repository {
  tracked: number;
  pullRequests: number;
}

export interface AccountListPayload {
  items: Account[];
}

export const api = {
  health: () => request<{ ok: boolean; version: string; node: string }>('/api/health'),

  overview: () => request<OverviewPayload>('/api/system/overview'),
  activity: (limit = 80) =>
    request<{ items: ActivityEntry[] }>(`/api/system/activity?limit=${limit}`),
  orchestrator: () => request<OrchestratorStatus>('/api/orchestrator'),
  tick: () =>
    request<{ report: unknown; status: OrchestratorStatus }>('/api/orchestrator/tick', {
      method: 'POST',
    }),
  restartOrchestrator: () =>
    request<{ status: OrchestratorStatus }>('/api/orchestrator/restart', { method: 'POST' }),

  accounts: {
    list: () => request<AccountListPayload>('/api/accounts'),
    create: (body: {
      name: string;
      provider: ProviderKind;
      baseUrl?: string;
      token: string;
      verify?: boolean;
      proxyMode?: Account['proxyMode'];
      proxyUrl?: string | null;
    }) =>
      request<{ account: Account }>('/api/accounts', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (
      id: string,
      body: {
        name?: string;
        baseUrl?: string;
        token?: string;
        verify?: boolean;
        proxyMode?: Account['proxyMode'];
        proxyUrl?: string | null;
      },
    ) =>
      request<{ account: Account }>(`/api/accounts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    remove: (id: string) => request<void>(`/api/accounts/${id}`, { method: 'DELETE' }),
    test: (id: string) =>
      request<{ ok: boolean; error?: string; user?: { login: string } }>(
        `/api/accounts/${id}/test`,
        {
          method: 'POST',
        },
      ),
    repositories: (
      id: string,
      params: { page?: number; perPage?: number; search?: string } = {},
    ) => {
      const query = new URLSearchParams();
      if (params.page) query.set('page', String(params.page));
      if (params.perPage) query.set('perPage', String(params.perPage));
      if (params.search) query.set('search', params.search);
      return request<{ page: number; hasMore: boolean; items: RemoteRepositorySummary[] }>(
        `/api/accounts/${id}/repositories?${query.toString()}`,
      );
    },
  },

  repositories: {
    list: () => request<{ items: RepositoryListItem[] }>('/api/repositories'),
    import: (body: { accountId: string; fullName: string; enabled?: boolean }) =>
      request<{ repository: Repository }>('/api/repositories', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (id: string, body: { enabled?: boolean; defaultBranch?: string }) =>
      request<{ repository: Repository }>(`/api/repositories/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    remove: (id: string, purge = false) =>
      request<void>(`/api/repositories/${id}${purge ? '?purge=true' : ''}`, { method: 'DELETE' }),
    overview: (id: string) => request<RepositoryOverview>(`/api/repositories/${id}/overview`),
    labelPreview: (id: string) =>
      request<{ labels: LabelPreviewRow[] }>(`/api/repositories/${id}/labels/preview`),
    initializeLabels: (id: string) =>
      request<{ result: LabelSyncResult; repository: Repository }>(
        `/api/repositories/${id}/labels/initialize`,
        { method: 'POST' },
      ),
    sync: (id: string) =>
      request<{ report: unknown; repository: Repository }>(`/api/repositories/${id}/sync`, {
        method: 'POST',
      }),
    runTask: (
      id: string,
      body: { kind: 'implement' | 'review' | 'fix'; issueNumber?: number; prNumber?: number },
    ) =>
      request<{ task: Task }>(`/api/repositories/${id}/tasks`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  tasks: {
    list: (params: { repositoryId?: string; status?: TaskStatus; limit?: number } = {}) => {
      const query = new URLSearchParams();
      if (params.repositoryId) query.set('repositoryId', params.repositoryId);
      if (params.status) query.set('status', params.status);
      if (params.limit) query.set('limit', String(params.limit));
      return request<{ items: Task[]; counts: Record<string, number> }>(
        `/api/tasks?${query.toString()}`,
      );
    },
    detail: (id: string) => request<{ task: Task; logs: TaskLogLine[] }>(`/api/tasks/${id}`),
    cancel: (id: string) =>
      request<{ cancelled: boolean; task: Task | null }>(`/api/tasks/${id}/cancel`, {
        method: 'POST',
      }),
    retry: (id: string) => request<{ task: Task }>(`/api/tasks/${id}/retry`, { method: 'POST' }),
  },

  codex: {
    status: (force = false) =>
      request<{ status: CodexStatus }>(`/api/codex/status${force ? '?force=1' : ''}`),
    install: () => request<{ state: CodexInstallState }>('/api/codex/install', { method: 'POST' }),
    installState: () => request<{ state: CodexInstallState }>('/api/codex/install'),
    invalidate: () => request<{ status: CodexStatus }>('/api/codex/invalidate', { method: 'POST' }),
    probe: () => request<{ probe: CodexModelProbe }>('/api/codex/probe', { method: 'POST' }),
    config: () =>
      request<{
        config: CodexConfigPayload;
        backups: Array<{ name: string; createdAt: string; size: number }>;
      }>('/api/codex/config'),
    saveConfig: (content: string) =>
      request<{
        config: CodexConfigPayload;
        backups: Array<{ name: string; createdAt: string; size: number }>;
      }>('/api/codex/config', { method: 'PUT', body: JSON.stringify({ content }) }),
    promptPreview: (params: {
      repositoryId: string;
      kind: 'implement' | 'review' | 'fix';
      issueNumber?: number;
      prNumber?: number;
    }) => {
      const query = new URLSearchParams({ repositoryId: params.repositoryId, kind: params.kind });
      if (params.issueNumber) query.set('issueNumber', String(params.issueNumber));
      if (params.prNumber) query.set('prNumber', String(params.prNumber));
      return request<{ prompt: string }>(`/api/codex/prompt-preview?${query.toString()}`);
    },
  },

  settings: {
    get: () =>
      request<{
        settings: AppSettings;
        runtime: {
          home: string;
          dataDir: string;
          workspacesDir: string;
          dbFile: string;
          codexHome: string;
          webDist: string | null;
          port: number;
          host: string;
          nodeVersion: string;
        };
      }>('/api/settings'),
    update: (body: Partial<AppSettings>) =>
      request<{ settings: AppSettings }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
  },

  proxy: {
    get: () => request<{ config: ProxyConfigPayload }>('/api/proxy'),
    update: (body: {
      settings?: Partial<ProxySettings>;
      /** `null` 清除通道，缺省表示保持不变。 */
      httpProxy?: string | null;
      socks5Proxy?: string | null;
    }) =>
      request<{ config: ProxyConfigPayload }>('/api/proxy', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    test: (
      body: {
        slots?: ProxySlot[];
        accountId?: string;
        includeGit?: boolean;
        timeoutMs?: number;
        draft?: {
          httpProxy?: string | null;
          socks5Proxy?: string | null;
        };
      } = {},
    ) =>
      request<{ report: ProxyTestReport }>('/api/proxy/test', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
