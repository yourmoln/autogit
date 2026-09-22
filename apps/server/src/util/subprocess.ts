import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { LogStream } from '@autogit/shared';

export interface OutputLine {
  stream: LogStream;
  message: string;
  ts: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: OutputLine) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  input?: string;
}

export interface RunResult {
  command: string;
  args: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  spawnError: string | null;
}

const executableCache = new Map<string, string | null>();

function pathDirectories(): string[] {
  const raw = process.env.PATH ?? process.env.Path ?? '';
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => entry.length > 0);
}

function extensions(): string[] {
  if (process.platform !== 'win32') return [''];
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return [
    '',
    ...raw
      .split(';')
      .filter(Boolean)
      .map((ext) => ext.toLowerCase()),
  ];
}

/**
 * Locates an executable the same way a shell would. Needed on Windows because
 * `spawn('codex')` cannot resolve `codex.cmd` without `shell: true`.
 */
export function whichCommand(name: string): string | null {
  const cached = executableCache.get(name);
  if (cached !== undefined) return cached;

  const result = resolveUncached(name);
  executableCache.set(name, result);
  return result;
}

function resolveUncached(name: string): string | null {
  if (!name) return null;
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    return existsSync(name) ? name : null;
  }

  for (const dir of pathDirectories()) {
    for (const ext of extensions()) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function clearExecutableCache(): void {
  executableCache.clear();
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const resolved = whichCommand(command) ?? command;
  const startedAt = Date.now();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  return await new Promise<RunResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnError: string | null = null;
    let timeout: NodeJS.Timeout | null = null;

    const child = spawn(resolved, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const emit = (stream: LogStream, message: string): void => {
      options.onLine?.({ stream, message, ts: new Date().toISOString() });
    };

    const pump = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout') stdoutChunks.push(text);
      else stderrChunks.push(text);

      if (!options.onLine) return;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.replace(/\s+$/, '');
        if (trimmed.length === 0) continue;
        emit(stream, trimmed);
      }
    };

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        command,
        args,
        code,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        durationMs: Date.now() - startedAt,
        timedOut,
        aborted,
        spawnError,
      });
    };

    const killTree = (): void => {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill('SIGKILL'));
        return;
      }
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    function onAbort(): void {
      aborted = true;
      killTree();
    }

    child.stdout?.on('data', (chunk: Buffer) => pump('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => pump('stderr', chunk));
    child.on('error', (error: Error) => {
      spawnError = error.message;
      emit('stderr', error.message);
      finish(null);
    });
    child.on('close', (code: number | null) => finish(code));

    if (options.input !== undefined) {
      child.stdin?.write(options.input);
    }
    child.stdin?.end();

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        emit('system', `命令超时（${Math.round(options.timeoutMs! / 1000)}s），正在终止进程`);
        killTree();
      }, options.timeoutMs);
    }

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
