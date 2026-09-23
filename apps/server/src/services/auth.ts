import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import {
  AUTH_MAX_PASSWORD_LENGTH,
  AUTH_MAX_USERNAME_LENGTH,
  AUTH_MIN_PASSWORD_LENGTH,
  AUTH_MIN_USERNAME_LENGTH,
  type AuthCredentialsSummary,
  type AuthSession,
  DEFAULT_AUTH_PASSWORD,
  DEFAULT_AUTH_USERNAME,
} from '@autogit/shared';

import type { AuthAccountRecord, Store } from '../db/store.js';
import { HttpError } from '../util/http.js';
import { logger } from '../util/logger.js';
import { nowIso } from '../util/time.js';

/** Name of the session cookie; the token value itself is random per login. */
export const AUTH_SESSION_COOKIE = 'autogit_session';

/** Sessions without "保持登录": they die when the browser session ends. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Sessions with "保持登录": sliding 30 day window, refreshed on use. */
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Only write a renewal back to SQLite when it is this old. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Consecutive failed logins tolerated before the endpoint starts to slow down. */
export const AUTH_LOGIN_FAILURE_LIMIT = 5;
/** Length of the first penalty window; every further failure doubles it. */
export const AUTH_LOGIN_BACKOFF_MS = 1_000;
/** Longest penalty window, so a forgotten password only costs a short pause. */
export const AUTH_LOGIN_MAX_BACKOFF_MS = 30_000;

const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const SCRYPT_PREFIX = 'scrypt';

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * `Max-Age` of the session cookie, or `null` for a browser session cookie.
 *
 * "保持登录" sessions carry their sliding 30 day window; everything else lives
 * only as long as the browser keeps the cookie.
 */
export function sessionCookieMaxAge(session: AuthSession): number | null {
  if (!session.persistent) return null;
  return Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000));
}

/**
 * scrypt hash in a self describing payload:
 * `scrypt:<cost>:<blockSize>:<parallelization>:<salt>:<derivedKey>`
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  return [
    SCRYPT_PREFIX,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join(':');
}

export function verifyPasswordHash(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== SCRYPT_PREFIX) return false;

  const cost = Number.parseInt(parts[1] ?? '', 10);
  const blockSize = Number.parseInt(parts[2] ?? '', 10);
  const parallelization = Number.parseInt(parts[3] ?? '', 10);
  if (!Number.isFinite(cost) || !Number.isFinite(blockSize) || !Number.isFinite(parallelization)) {
    return false;
  }

  const salt = Buffer.from(parts[4] as string, 'base64url');
  const expected = Buffer.from(parts[5] as string, 'base64url');
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: SCRYPT_MAX_MEMORY,
    });
  } catch {
    // Corrupted or hand edited payloads must simply not match.
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Hash `login()` verifies against when the submitted username does not match.
 *
 * Every login attempt has to cost exactly one scrypt: bailing out early on an
 * unknown username would make "wrong username" measurably faster than "wrong
 * password" (~0ms vs ~25ms) and turn the endpoint into a username oracle. The
 * value is irrelevant — nothing can match it — it only has to be a well formed
 * payload with the same parameters, so it is built once, lazily.
 */
let decoyPasswordHash: string | null = null;

function decoyHash(): string {
  decoyPasswordHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return decoyPasswordHash;
}

function sessionTtlMs(persistent: boolean): number {
  return persistent ? REMEMBER_TTL_MS : SESSION_TTL_MS;
}

function sameUsername(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

function normalizeUsername(value: string): string {
  const username = value.trim();
  if (username.length < AUTH_MIN_USERNAME_LENGTH || username.length > AUTH_MAX_USERNAME_LENGTH) {
    throw new HttpError(
      400,
      `用户名长度需在 ${AUTH_MIN_USERNAME_LENGTH} - ${AUTH_MAX_USERNAME_LENGTH} 个字符之间`,
    );
  }
  return username;
}

function normalizePassword(value: string): string {
  if (value.length < AUTH_MIN_PASSWORD_LENGTH || value.length > AUTH_MAX_PASSWORD_LENGTH) {
    throw new HttpError(
      400,
      `密码长度需在 ${AUTH_MIN_PASSWORD_LENGTH} - ${AUTH_MAX_PASSWORD_LENGTH} 个字符之间`,
    );
  }
  return value;
}

export interface AuthLoginResult {
  /** Raw session token, handed to the browser as an HttpOnly cookie. */
  token: string;
  session: AuthSession;
}

export interface ResolvedAuthSession {
  session: AuthSession;
  /** SHA-256 of the presented token; identifies the session to live streams. */
  tokenHash: string;
  /**
   * `true` when this call slid the expiry forward, i.e. the browser cookie has
   * to be re-issued with the new `Max-Age` as well.
   */
  renewed: boolean;
}

/**
 * Sessions that just stopped being valid.
 *
 * `null` means "every session" (a credential change rotates all of them), an
 * array names the affected token hashes. Live WebSocket clients subscribe to
 * this because the handshake check only covers new connections.
 */
export type RevokedSessions = readonly string[] | null;

/**
 * Login gate for the whole app.
 *
 * One credential pair lives in SQLite (`auth_account`), sessions are stored as
 * SHA-256 hashes so a database leak cannot be replayed, and the password only
 * exists as a scrypt hash. AutoGit runs on localhost for a single user, hence
 * "one account, no user table".
 */
export class AuthService {
  private readonly revocationListeners = new Set<(revoked: RevokedSessions) => void>();
  /** Failed logins since the last success; drives the login backoff below. */
  private loginFailures = 0;
  /** Wall clock until which `login()` answers 429 instead of verifying. */
  private loginBlockedUntil = 0;

  constructor(private readonly store: Store) {
    // Warm the decoy hash up front: built lazily, the very first unknown-username
    // attempt would pay two scrypts and stand out from a wrong password.
    decoyHash();
  }

  /** Creates the factory `admin` / `admin` credentials on first start. */
  bootstrap(): void {
    this.pruneExpiredSessions();
    const account = this.store.getAuthAccount();
    if (account) {
      this.backfillPasswordChangedAt(account);
      return;
    }

    this.store.upsertAuthAccount({
      username: DEFAULT_AUTH_USERNAME,
      passwordHash: hashPassword(DEFAULT_AUTH_PASSWORD),
      passwordChanged: false,
    });
    logger().warn(
      `已创建默认登录账号 ${DEFAULT_AUTH_USERNAME} / ${DEFAULT_AUTH_PASSWORD}，请尽快在「设置」页修改`,
    );
  }

  login(input: { username: string; password: string; remember: boolean }): AuthLoginResult {
    const now = Date.now();
    const blockedForMs = this.loginBlockedUntil - now;
    if (blockedForMs > 0) {
      throw new HttpError(429, `登录失败次数过多，请 ${Math.ceil(blockedForMs / 1000)} 秒后重试`);
    }

    const account = this.store.getAuthAccount();
    const username = input.username.trim();
    const usernameMatches = account !== null && sameUsername(account.username, username);
    // One scrypt either way: the decoy hash keeps an unknown username from being
    // distinguishable from a wrong password by response time.
    const passwordMatches = verifyPasswordHash(
      input.password,
      account !== null && usernameMatches ? account.passwordHash : decoyHash(),
    );
    if (!account || !usernameMatches || !passwordMatches) {
      this.noteLoginFailure(now);
      throw new HttpError(401, '用户名或密码不正确');
    }
    this.clearLoginFailures();

    this.pruneExpiredSessions();

    const token = randomBytes(32).toString('base64url');
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + sessionTtlMs(input.remember)).toISOString();
    this.store.createAuthSession({
      tokenHash: hashSessionToken(token),
      username: account.username,
      persistent: input.remember,
      createdAt,
      expiresAt,
    });

    return {
      token,
      session: {
        username: account.username,
        persistent: input.remember,
        createdAt,
        lastSeenAt: createdAt,
        expiresAt,
      },
    };
  }

  /**
   * Resolves a bearer token. Returns `null` for unknown, expired or revoked
   * sessions, which is exactly what the API guard turns into HTTP 401.
   */
  resolveSession(token: string | null | undefined): ResolvedAuthSession | null {
    const raw = token?.trim();
    if (!raw) return null;

    const tokenHash = hashSessionToken(raw);
    const record = this.store.getAuthSession(tokenHash);
    if (!record) return null;

    const now = Date.now();
    if (Date.parse(record.expiresAt) <= now) {
      this.dropSession(tokenHash);
      return null;
    }

    // Credentials were replaced (or removed) after this session was issued.
    const account = this.store.getAuthAccount();
    if (!account || !sameUsername(account.username, record.username)) {
      this.dropSession(tokenHash);
      return null;
    }

    let { lastSeenAt, expiresAt } = record;
    let renewed = false;
    // Sliding expiry: an active "保持登录" session keeps its full 30 day window,
    // but the renewal is throttled so pollers do not turn into write storms.
    // Sessions without "保持登录" are capped by their 12 hour TTL instead of
    // sliding, so leaving a tab open cannot turn them into a permanent login.
    if (record.persistent && now - Date.parse(record.lastSeenAt) > TOUCH_INTERVAL_MS) {
      lastSeenAt = new Date(now).toISOString();
      expiresAt = new Date(now + sessionTtlMs(record.persistent)).toISOString();
      this.store.touchAuthSession(tokenHash, lastSeenAt, expiresAt);
      renewed = true;
    }

    return {
      tokenHash,
      renewed,
      session: {
        username: account.username,
        persistent: record.persistent,
        createdAt: record.createdAt,
        lastSeenAt,
        expiresAt,
      },
    };
  }

  /**
   * Observes revocation, so an already established realtime connection can be
   * closed the moment its session disappears.
   */
  onSessionRevoked(listener: (revoked: RevokedSessions) => void): () => void {
    this.revocationListeners.add(listener);
    return () => {
      this.revocationListeners.delete(listener);
    };
  }

  logout(token: string | null | undefined): void {
    const raw = token?.trim();
    if (!raw) return;
    this.dropSession(hashSessionToken(raw));
  }

  credentialsSummary(): AuthCredentialsSummary {
    const account = this.store.getAuthAccount();
    if (!account) throw new HttpError(500, '登录账号尚未初始化');
    return {
      username: account.username,
      updatedAt: account.updatedAt,
      // Cheap on purpose: this runs on every `GET /api/auth/session`. Asking the
      // stored hash whether it still verifies the factory password would mean a
      // blocking scrypt on each page load, so `password_changed_at` records it.
      defaultCredentials:
        sameUsername(account.username, DEFAULT_AUTH_USERNAME) && account.passwordChangedAt === null,
      activeSessions: this.store.countAuthSessions(nowIso()),
    };
  }

  /**
   * Changes the username and/or the password.
   *
   * The current password is mandatory, and every session is rotated: other
   * browsers are logged out immediately, while the caller receives a fresh
   * session so it stays signed in on the device where the change happened.
   */
  updateCredentials(input: {
    currentPassword: string;
    username?: string | null;
    password?: string | null;
    /** Keeps the caller's current "保持登录" preference for the new session. */
    persistent?: boolean;
  }): AuthLoginResult {
    const account = this.store.getAuthAccount();
    if (!account) throw new HttpError(500, '登录账号尚未初始化');
    if (!verifyPasswordHash(input.currentPassword, account.passwordHash)) {
      throw new HttpError(400, '当前密码不正确');
    }

    const username =
      typeof input.username === 'string' && input.username.trim().length > 0
        ? normalizeUsername(input.username)
        : account.username;
    const password =
      typeof input.password === 'string' && input.password.length > 0
        ? normalizePassword(input.password)
        : null;

    if (username !== account.username || password) {
      this.store.upsertAuthAccount({
        username,
        passwordHash: password ? hashPassword(password) : account.passwordHash,
        passwordChanged: password !== null,
      });
    }

    // Rotate every session: other browsers lose access immediately, and the
    // caller gets a fresh token below.
    this.store.deleteAuthSessions();
    this.announceRevocation(null);

    const persistent = input.persistent ?? false;
    const token = randomBytes(32).toString('base64url');
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + sessionTtlMs(persistent)).toISOString();
    this.store.createAuthSession({
      tokenHash: hashSessionToken(token),
      username,
      persistent,
      createdAt,
      expiresAt,
    });

    return {
      token,
      session: {
        username,
        persistent,
        createdAt,
        lastSeenAt: createdAt,
        expiresAt,
      },
    };
  }

  private pruneExpiredSessions(): void {
    this.store.deleteExpiredAuthSessions(nowIso());
  }

  /**
   * Slows down guessing. The first {@link AUTH_LOGIN_FAILURE_LIMIT} failures are
   * free, then every further one pushes a penalty window that doubles up to
   * {@link AUTH_LOGIN_MAX_BACKOFF_MS}. The window simply expires — a wrong
   * password never locks the only account out permanently — and a successful
   * login resets the counter.
   */
  private noteLoginFailure(now: number): void {
    this.loginFailures += 1;
    if (this.loginFailures < AUTH_LOGIN_FAILURE_LIMIT) return;
    const penaltyMs = Math.min(
      AUTH_LOGIN_BACKOFF_MS * 2 ** (this.loginFailures - AUTH_LOGIN_FAILURE_LIMIT),
      AUTH_LOGIN_MAX_BACKOFF_MS,
    );
    this.loginBlockedUntil = now + penaltyMs;
  }

  private clearLoginFailures(): void {
    this.loginFailures = 0;
    this.loginBlockedUntil = 0;
  }

  /** Deletes a session and tells live streams that it is gone. */
  private dropSession(tokenHash: string): void {
    if (this.store.deleteAuthSession(tokenHash) === 0) return;
    this.announceRevocation([tokenHash]);
  }

  private announceRevocation(revoked: RevokedSessions): void {
    for (const listener of [...this.revocationListeners]) {
      try {
        listener(revoked);
      } catch {
        // A broken socket must never break a logout or a credential change.
      }
    }
  }

  /**
   * Databases written before `password_changed_at` existed cannot say whether
   * the password was ever replaced. Verify once at startup — a single scrypt —
   * and persist the answer so the request path never has to ask again.
   */
  private backfillPasswordChangedAt(account: AuthAccountRecord): void {
    if (account.passwordChangedAt !== null) return;
    if (account.updatedAt === account.createdAt) return;
    if (verifyPasswordHash(DEFAULT_AUTH_PASSWORD, account.passwordHash)) return;
    this.store.markAuthPasswordChanged(account.updatedAt);
  }
}
