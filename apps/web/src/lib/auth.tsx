import type { AuthCredentialsSummary, AuthSession, AuthSessionPayload } from '@autogit/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from 'react';

import { ApiRequestError, api } from './api.js';
import { realtime } from './realtime.js';
import { onUnauthorized } from './session-events.js';

const AUTH_SESSION_KEY = ['auth-session'] as const;

const ANONYMOUS: AuthSessionPayload = {
  authenticated: false,
  session: null,
  credentials: null,
};

export interface LoginInput {
  username: string;
  password: string;
  /** 「保持登录」：勾选后关闭浏览器仍然有效。 */
  remember: boolean;
}

export interface CredentialsUpdateInput {
  currentPassword: string;
  username?: string | null;
  password?: string | null;
}

export interface CredentialsUpdateResult {
  session: AuthSession;
  /**
   * `false` 表示这次请求没有实际改动凭据（用户名与当前一致、密码留空或与当前
   * 密码相同）：服务端没有轮换会话，其他设备保持登录，界面不应提示「已更新」。
   */
  rotated: boolean;
}

export interface AuthContextValue {
  session: AuthSession | null;
  credentials: AuthCredentialsSummary | null;
  /** `true` 表示还在询问服务端当前会话状态。 */
  loading: boolean;
  login: (input: LoginInput) => Promise<AuthSession>;
  logout: () => Promise<void>;
  updateCredentials: (input: CredentialsUpdateInput) => Promise<CredentialsUpdateResult>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Owns the login state for the whole console.
 *
 * The session itself lives in an HttpOnly cookie; this provider only keeps the
 * answer of `GET /api/auth/session` in the React Query cache, so every page can
 * read the current account without asking the server again.
 */
export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const queryClient = useQueryClient();

  const session = useQuery({
    queryKey: AUTH_SESSION_KEY,
    queryFn: api.auth.session,
    // A 401 is final, anything else deserves one retry: a flaky first request
    // must not look like "not logged in" and bounce the user to /login.
    retry: (failureCount, error) =>
      failureCount < 2 && !(error instanceof ApiRequestError && error.status === 401),
    staleTime: 30_000,
  });

  const applyPayload = useCallback(
    (payload: AuthSessionPayload): void => {
      queryClient.setQueryData(AUTH_SESSION_KEY, payload);
    },
    [queryClient],
  );

  // Any 401 from a protected endpoint means the cookie is gone (expired,
  // revoked by a credential change on another device, or logged out remotely).
  useEffect(
    () =>
      onUnauthorized(() => {
        realtime.stop();
        applyPayload(ANONYMOUS);
      }),
    [applyPayload],
  );

  const login = useCallback<AuthContextValue['login']>(
    async (input) => {
      const payload = await api.auth.login(input);
      applyPayload(payload);
      if (!payload.session) throw new Error('登录响应缺少会话信息');
      return payload.session;
    },
    [applyPayload],
  );

  const logout = useCallback<AuthContextValue['logout']>(async () => {
    try {
      await api.auth.logout();
    } finally {
      realtime.stop();
      // Drop every cached page before the next login, they belonged to the
      // previous session.
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== AUTH_SESSION_KEY[0],
      });
      applyPayload(ANONYMOUS);
    }
  }, [applyPayload, queryClient]);

  const updateCredentials = useCallback<AuthContextValue['updateCredentials']>(
    async (input) => {
      try {
        const payload = await api.auth.updateCredentials(input);
        applyPayload(payload);
        if (!payload.session) throw new Error('保存响应缺少会话信息');
        // `rotated: false` 是「没有任何改动」的回答：Cookie 没有换、其他设备也
        // 没有被登出，调用方据此给出如实的提示，而不是一句「已更新」。
        return { session: payload.session, rotated: payload.rotated === true };
      } catch (error) {
        // The rotation revokes the old sessions before it answers, so a request
        // that fails or never arrives can leave this tab holding a cookie that no
        // longer exists — and the server no longer closes its socket as "signed
        // out" either. Ask the server again instead of trusting the cached
        // session: a live session leaves the state alone, a dead cookie sends the
        // tab to the login page.
        await queryClient.invalidateQueries({ queryKey: AUTH_SESSION_KEY }).catch(() => undefined);
        throw error;
      }
    },
    [applyPayload, queryClient],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      session: session.data?.session ?? null,
      credentials: session.data?.credentials ?? null,
      loading: session.isPending,
      login,
      logout,
      updateCredentials,
    }),
    [login, logout, session.data, session.isPending, updateCredentials],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return value;
}
