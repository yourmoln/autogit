/**
 * Login model of AutoGit.
 *
 * AutoGit is a single user tool: there is exactly one credential pair, stored
 * in the local SQLite database. The client only knows whether the current
 * browser holds a valid session — password material never leaves the server.
 */

/** Factory credentials, used until the user changes them in the settings page. */
export const DEFAULT_AUTH_USERNAME = 'admin';
export const DEFAULT_AUTH_PASSWORD = 'admin';

export const AUTH_MIN_USERNAME_LENGTH = 2;
export const AUTH_MAX_USERNAME_LENGTH = 32;
export const AUTH_MIN_PASSWORD_LENGTH = 4;
export const AUTH_MAX_PASSWORD_LENGTH = 128;

export interface AuthSession {
  username: string;
  /** `true` 表示「保持登录」：关闭浏览器后会话仍然有效。 */
  persistent: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface AuthCredentialsSummary {
  username: string;
  updatedAt: string;
  /**
   * 密码仍是出厂默认的 `admin`（用户名可以已经改过），界面上会提示尽快修改。
   */
  defaultCredentials: boolean;
  /** 当前有效的会话数（包含发起请求的这一条）。 */
  activeSessions: number;
}

export interface AuthSessionPayload {
  authenticated: boolean;
  session: AuthSession | null;
  /** 仅在已登录时返回，未登录时为 `null`。 */
  credentials: AuthCredentialsSummary | null;
}
