import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDotEnv } from './util/dotenv.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const repoRoot = path.resolve(serverRoot, '..', '..');

loadDotEnv(path.join(repoRoot, '.env'));
loadDotEnv(path.join(serverRoot, '.env'));

export interface RuntimeConfig {
  home: string;
  dataDir: string;
  workspacesDir: string;
  dbFile: string;
  secretKeyPath: string;
  logDir: string;
  logLevel: string;
  host: string;
  port: number;
  webDist: string | null;
  codexHome: string;
  codexPathOverride: string | null;
  defaultPollSeconds: number;
  defaultMaxConcurrent: number;
  defaultMaxConcurrentPerRepo: number;
  /**
   * Extra origins the realtime upgrade accepts although they do not name the
   * host the request arrived on (reverse proxies that rewrite `Host`, or a dev
   * server on another machine). See `util/origin.ts`.
   */
  allowedOrigins: string[];
  /**
   * Origins of the local Vite dev console (`AUTOGIT_DEV_ORIGINS`), trusted only
   * while {@link RuntimeConfig.isDev} is set. Empty in production, so a
   * self-hosted instance accepts same-origin handshakes plus
   * `AUTOGIT_ALLOWED_ORIGINS` and nothing else. See `util/origin.ts`.
   */
  devOrigins: string[];
  isDev: boolean;
  repoRoot: string;
}

function asNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveHome(): string {
  const configured = process.env.AUTOGIT_HOME?.trim();
  if (configured) return path.resolve(configured);
  return path.join(homedir(), '.autogit');
}

function resolveWebDist(): string | null {
  const configured = process.env.AUTOGIT_WEB_DIST?.trim();
  const candidate = configured
    ? path.resolve(configured)
    : path.join(repoRoot, 'apps', 'web', 'dist');
  return existsSync(candidate) ? candidate : null;
}

/** Splits a comma separated env var into trimmed, non empty entries. */
function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * `AUTOGIT_ALLOWED_ORIGINS=https://a.example,https://b.example` →
 * `['https://a.example', 'https://b.example']`.
 *
 * `util/origin.ts` compares the listed entries as complete origins: an entry
 * that names a scheme only matches that scheme (`https://a.example` no longer
 * accepts `http://a.example`), which is why the docs spell the scheme out. A
 * bare `host[:port]` entry keeps the older host-only meaning.
 */
function resolveAllowedOrigins(): string[] {
  return splitList(process.env.AUTOGIT_ALLOWED_ORIGINS);
}

/** Origins the local Vite dev server is served from unless told otherwise. */
const DEFAULT_DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/**
 * Origins the Vite dev console is reached from.
 *
 * Vite proxies `/api` with `changeOrigin: true`, so the backend sees
 * `Origin: http://localhost:5173` next to `Host: 127.0.0.1:4711` and a strict
 * same-origin comparison would lock the dev console out of its realtime
 * channel. The allowance is deliberately narrower than "any loopback origin"
 * (the previous behaviour): a page served on *any* other local port is
 * same-site for `127.0.0.1`, so the `SameSite=Lax` session cookie travels with
 * its WebSocket handshake and it could read task logs. `AUTOGIT_DEV_ORIGINS`
 * replaces the defaults — list the port Vite actually bound when 5173 was
 * taken. The entries are compared as complete origins, so a dev server served
 * over HTTPS belongs here as `https://localhost:5173`; `http://…` and `https://…`
 * of the same host are different origins (see `util/origin.ts`).
 *
 * Development only: production ignores this variable, list extra origins in
 * `AUTOGIT_ALLOWED_ORIGINS` there.
 */
function resolveDevOrigins(isDev: boolean): string[] {
  if (!isDev) return [];
  const configured = splitList(process.env.AUTOGIT_DEV_ORIGINS);
  return configured.length > 0 ? configured : [...DEFAULT_DEV_ORIGINS];
}

/**
 * `true` when a module url names JavaScript emitted by the build (`dist`)
 * instead of TypeScript source loaded by `tsx`.
 */
export function isCompiledEntry(entryUrl: string): boolean {
  try {
    return /\.(?:[cm]?js)$/i.test(new URL(entryUrl).pathname);
  } catch {
    return false;
  }
}

/**
 * Defaults `NODE_ENV` for a process that never set it.
 *
 * `pnpm start` runs `node dist/index.js` and `pnpm dev` runs `tsx
 * src/index.ts`, but only the first is the documented production start, and npm
 * scripts cannot portably export `NODE_ENV`. Left to the old implicit default
 * (`NODE_ENV !== 'production'`), a self-hosted install that follows the README
 * silently ran the development policy, which also trusted the loopback origins
 * of a dev server. A compiled entry therefore defaults to `production`; an
 * explicit `NODE_ENV` always wins and the TypeScript entry keeps the
 * development default.
 */
export function applyDefaultNodeEnv(
  /** `import.meta.url` of the executing entry point, not of this module. */
  entryUrl: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.NODE_ENV?.trim()) return;
  if (isCompiledEntry(entryUrl)) env.NODE_ENV = 'production';
}

export function loadRuntimeConfig(): RuntimeConfig {
  const home = resolveHome();
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex');
  const isDev = process.env.NODE_ENV !== 'production';

  return {
    home,
    dataDir: path.join(home, 'data'),
    workspacesDir: path.join(home, 'workspaces'),
    dbFile: path.join(home, 'data', 'autogit.sqlite'),
    secretKeyPath: path.join(home, 'secret.key'),
    logDir: path.join(home, 'logs'),
    logLevel: process.env.AUTOGIT_LOG_LEVEL?.trim() || 'info',
    host: process.env.AUTOGIT_HOST?.trim() || '127.0.0.1',
    port: asNumber(process.env.AUTOGIT_PORT, 4711),
    webDist: resolveWebDist(),
    codexHome,
    codexPathOverride: process.env.AUTOGIT_CODEX_PATH?.trim() || null,
    defaultPollSeconds: asNumber(process.env.AUTOGIT_POLL_SECONDS, 45),
    defaultMaxConcurrent: asNumber(process.env.AUTOGIT_MAX_CONCURRENT, 2),
    defaultMaxConcurrentPerRepo: asNumber(process.env.AUTOGIT_MAX_CONCURRENT_PER_REPO, 1),
    allowedOrigins: resolveAllowedOrigins(),
    devOrigins: resolveDevOrigins(isDev),
    isDev,
    repoRoot,
  };
}

export function ensureRuntimeDirectories(config: RuntimeConfig): void {
  for (const dir of [config.home, config.dataDir, config.workspacesDir, config.logDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
