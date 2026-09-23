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

import type { Store } from '../db/store.js';
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

/**
 * Login gate for the whole app.
 *
 * One credential pair lives in SQLite (`auth_account`), sessions are stored as
 * SHA-256 hashes so a database leak cannot be replayed, and the password only
 * exists as a scrypt hash. AutoGit runs on localhost for a single user, hence
 * "one account, no user table".
 */
export class AuthService {
  constructor(private readonly store: Store) {}

  /** Creates the factory `admin` / `admin` credentials on first start. */
  bootstrap(): void {
    this.pruneExpiredSessions();
    if (this.store.getAuthAccount()) return;

    this.store.upsertAuthAccount({
      username: DEFAULT_AUTH_USERNAME,
      passwordHash: hashPassword(DEFAULT_AUTH_PASSWORD),
    });
    logger().warn(
      `已创建默认登录账号 ${DEFAULT_AUTH_USERNAME} / ${DEFAULT_AUTH_PASSWORD}，请尽快在「设置」页修改`,
    );
  }

  login(input: { username: string; password: string; remember: boolean }): AuthLoginResult {
    const account = this.store.getAuthAccount();
    const username = input.username.trim();
    const valid =
      account !== null &&
      sameUsername(account.username, username) &&
      verifyPasswordHash(input.password, account.passwordHash);
    if (!account || !valid) {
      throw new HttpError(401, '用户名或密码不正确');
    }

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
  resolveSession(token: string | null | undefined): AuthSession | null {
    const raw = token?.trim();
    if (!raw) return null;

    const tokenHash = hashSessionToken(raw);
    const record = this.store.getAuthSession(tokenHash);
    if (!record) return null;

    const now = Date.now();
    if (Date.parse(record.expiresAt) <= now) {
      this.store.deleteAuthSession(tokenHash);
      return null;
    }

    // Credentials were replaced (or removed) after this session was issued.
    const account = this.store.getAuthAccount();
    if (!account || !sameUsername(account.username, record.username)) {
      this.store.deleteAuthSession(tokenHash);
      return null;
    }

    let { lastSeenAt, expiresAt } = record;
    // Sliding expiry: an active "保持登录" session never logs you out, but the
    // renewal is throttled so pollers do not turn into write storms.
    if (now - Date.parse(record.lastSeenAt) > TOUCH_INTERVAL_MS) {
      lastSeenAt = new Date(now).toISOString();
      expiresAt = new Date(now + sessionTtlMs(record.persistent)).toISOString();
      this.store.touchAuthSession(tokenHash, lastSeenAt, expiresAt);
    }

    return {
      username: account.username,
      persistent: record.persistent,
      createdAt: record.createdAt,
      lastSeenAt,
      expiresAt,
    };
  }

  logout(token: string | null | undefined): void {
    const raw = token?.trim();
    if (!raw) return;
    this.store.deleteAuthSession(hashSessionToken(raw));
  }

  credentialsSummary(): AuthCredentialsSummary {
    const account = this.store.getAuthAccount();
    if (!account) throw new HttpError(500, '登录账号尚未初始化');
    return {
      username: account.username,
      updatedAt: account.updatedAt,
      defaultCredentials:
        sameUsername(account.username, DEFAULT_AUTH_USERNAME) &&
        verifyPasswordHash(DEFAULT_AUTH_PASSWORD, account.passwordHash),
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
      });
    }

    // Rotate every session: other browsers lose access immediately, and the
    // caller gets a fresh token below.
    this.store.deleteAuthSessions();

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
}
