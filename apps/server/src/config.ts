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

export function loadRuntimeConfig(): RuntimeConfig {
  const home = resolveHome();
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex');

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
    isDev: process.env.NODE_ENV !== 'production',
    repoRoot,
  };
}

export function ensureRuntimeDirectories(config: RuntimeConfig): void {
  for (const dir of [config.home, config.dataDir, config.workspacesDir, config.logDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
