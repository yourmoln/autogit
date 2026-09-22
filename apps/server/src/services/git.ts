import type { LogStream } from '@autogit/shared';

import { type RunResult, runCommand } from '../util/subprocess.js';

export interface GitRunOptions {
  cwd: string;
  authHeader?: string | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: { stream: LogStream; message: string; ts: string }) => void;
}

/**
 * Builds an environment that authenticates `git` without ever writing the
 * token into `.git/config` or the process command line.
 */
export function buildGitEnv(
  authHeader: string | null | undefined,
  extra?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  };

  // Remove any inherited multi-config entries first.
  delete env.GIT_CONFIG_COUNT;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_KEY_\d+$/.test(key) || /^GIT_CONFIG_VALUE_\d+$/.test(key)) delete env[key];
  }

  if (authHeader) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraheader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: ${authHeader}`;
  }

  return env;
}

export function gitArgs(...args: string[]): string[] {
  return args;
}

export async function git(args: string[], options: GitRunOptions): Promise<RunResult> {
  return runCommand('git', args, {
    cwd: options.cwd,
    env: buildGitEnv(options.authHeader, options.env),
    timeoutMs: options.timeoutMs ?? 10 * 60_000,
    signal: options.signal,
    onLine: options.onLine,
  });
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}
