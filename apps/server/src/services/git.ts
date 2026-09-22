import type { LogStream } from '@autogit/shared';

import { type RunResult, runCommand } from '../util/subprocess.js';

/** Proxy selection for a single git invocation. */
export interface GitProxyOption {
  /** `null` forces a direct connection, dropping inherited proxy variables. */
  url: string | null;
}

export interface GitEnvInput {
  authHeader?: string | null;
  /**
   * `undefined` leaves the inherited proxy environment untouched (used for the
   * Codex CLI, which may rely on its own HTTPS_PROXY). Passing an object makes
   * AutoGit authoritative for the proxy of that command.
   */
  proxy?: GitProxyOption | undefined;
  extra?: NodeJS.ProcessEnv;
}

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const;

export interface GitRunOptions {
  cwd: string;
  authHeader?: string | null;
  proxy?: GitProxyOption | undefined;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: { stream: LogStream; message: string; ts: string }) => void;
}

/**
 * Builds an environment that authenticates `git` and routes it through the
 * configured proxy, without ever writing the token into `.git/config` or the
 * process command line.
 */
export function buildGitEnv(input: GitEnvInput = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...input.extra,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  };

  // Remove any inherited multi-config entries first.
  delete env.GIT_CONFIG_COUNT;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_KEY_\d+$/.test(key) || /^GIT_CONFIG_VALUE_\d+$/.test(key)) delete env[key];
  }

  const entries: Array<[string, string]> = [];
  if (input.authHeader) {
    entries.push(['http.extraheader', `Authorization: ${input.authHeader}`]);
  }

  if (input.proxy) {
    for (const key of PROXY_ENV_KEYS) delete env[key];
    if (input.proxy.url) {
      // `http.proxy` covers http:// and https:// remotes alike, and also
      // accepts `socks5h://` because git hands the address to libcurl.
      entries.push(['http.proxy', input.proxy.url]);
      for (const key of PROXY_ENV_KEYS) env[key] = input.proxy.url;
      // A proxy address may carry credentials. Without this reset git asks the
      // credential helpers (Git Credential Manager on Windows) about the proxy
      // host, which probes it over HTTP and can hang the command for minutes.
      // AutoGit always authenticates through `http.extraheader`, so helpers are
      // never needed here.
      entries.push(['credential.helper', '']);
    }
  }

  if (entries.length > 0) {
    env.GIT_CONFIG_COUNT = String(entries.length);
    entries.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
  }

  return env;
}

export function gitArgs(...args: string[]): string[] {
  return args;
}

export async function git(args: string[], options: GitRunOptions): Promise<RunResult> {
  return runCommand('git', args, {
    cwd: options.cwd,
    env: buildGitEnv({
      authHeader: options.authHeader,
      proxy: options.proxy,
      extra: options.env,
    }),
    timeoutMs: options.timeoutMs ?? 10 * 60_000,
    signal: options.signal,
    onLine: options.onLine,
  });
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}
