import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { EngineId, LogStream } from '@autogit/shared';

import type { RuntimeConfig } from '../config.js';
import { childLogger } from '../util/logger.js';
import { runCommand } from '../util/subprocess.js';
import type { CodexService } from './codex.js';
import type { SettingsService } from './settings.js';

export type TaskLogger = (stream: LogStream, message: string) => void;

export interface ReviewIssue {
  severity: 'blocker' | 'major' | 'minor';
  title: string;
  detail: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

export interface ReviewVerdict {
  verdict: 'approve' | 'needs_fix';
  summary: string;
  issues: ReviewIssue[];
  tests?: string;
}

export interface EngineRunInput {
  taskId: string;
  engine: EngineId;
  cwd: string;
  prompt: string;
  log: TaskLogger;
  signal?: AbortSignal;
  timeoutMs: number;
  /** When set, the final answer is validated against this JSON schema. */
  outputSchema?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  taskDir: string;
}

export interface EngineRunResult {
  ok: boolean;
  exitCode: number | null;
  summary: string;
  output: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  error: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
}

interface ExtractedLine {
  stream: LogStream;
  message: string;
}

const MAX_JSON_DEPTH = 6;

/**
 * Runs a Codex (or Claude) agent against a workspace directory.
 *
 * The CLI surface differs between versions, so every flag is applied only when
 * the probed capability set says the binary understands it.
 */
export class EngineRunner {
  private readonly log = childLogger('runner');

  constructor(
    private readonly config: RuntimeConfig,
    private readonly settings: SettingsService,
    private readonly codex: CodexService,
  ) {}

  async run(input: EngineRunInput): Promise<EngineRunResult> {
    if (input.engine === 'claude') {
      return this.runClaude(input);
    }
    return this.runCodex(input);
  }

  private async runCodex(input: EngineRunInput): Promise<EngineRunResult> {
    const settings = this.settings.get();
    const capabilities = await this.codex.capabilities();
    const { path: binary } = this.codex.resolveBinary();

    if (!binary || !capabilities?.execCommand) {
      return {
        ok: false,
        exitCode: null,
        summary: '',
        output: '',
        durationMs: 0,
        timedOut: false,
        aborted: false,
        error: 'Codex CLI 不可用：请先在「Codex CLI」页面完成安装或配置路径。',
        usage: null,
      };
    }

    mkdirSync(input.taskDir, { recursive: true });
    const promptFile = path.join(input.taskDir, 'prompt.md');
    const lastMessageFile = path.join(input.taskDir, 'last-message.md');
    const schemaFile = path.join(input.taskDir, 'output-schema.json');
    writeFileSync(promptFile, input.prompt, 'utf8');
    if (existsSync(lastMessageFile)) rmSync(lastMessageFile, { force: true });

    const args = ['exec'];
    if (capabilities.jsonOutput) args.push('--json');
    if (settings.codexModel && capabilities.modelFlag) args.push('--model', settings.codexModel);
    if (capabilities.sandboxFlag) args.push('--sandbox', settings.codexSandbox);
    if (capabilities.cdFlag) args.push('--cd', input.cwd);
    if (capabilities.skipGitRepoCheck) args.push('--skip-git-repo-check');
    if (capabilities.ephemeral) args.push('--ephemeral');
    if (capabilities.outputLastMessage) args.push('--output-last-message', lastMessageFile);
    if (input.outputSchema && capabilities.outputSchema) {
      writeFileSync(schemaFile, JSON.stringify(input.outputSchema, null, 2), 'utf8');
      args.push('--output-schema', schemaFile);
    }
    if (capabilities.configOverride) {
      args.push('-c', `approval_policy="${settings.codexApprovalPolicy}"`);
      if (settings.codexSandbox === 'workspace-write') {
        args.push('-c', 'sandbox_workspace_write.network_access=true');
      }
    }
    args.push(...settings.codexExtraArgs);
    args.push('-');

    input.log('command', `codex ${args.join(' ')}`);

    let sawJson = false;
    const agentMessages: string[] = [];
    let usage: EngineRunResult['usage'] = null;

    const env: NodeJS.ProcessEnv = {
      ...input.env,
      CODEX_HOME: this.config.codexHome,
    };

    const result = await runCommand(binary, args, {
      cwd: input.cwd,
      env,
      input: input.prompt,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onLine: (line) => {
        const parsedLines = tryParseJsonLines(line.message);
        if (parsedLines.length === 0) {
          input.log(line.stream, line.message);
          return;
        }
        sawJson = true;
        for (const extracted of parsedLines) {
          if (extracted.stream === 'agent') agentMessages.push(extracted.message);
          if (extracted.message.trim().length === 0) continue;
          input.log(extracted.stream, extracted.message);
        }
        const tokens = extractUsage(line.message);
        if (tokens) usage = tokens;
      },
    });

    let summary = '';
    if (existsSync(lastMessageFile)) {
      summary = readFileSync(lastMessageFile, 'utf8').trim();
    }
    if (!summary && agentMessages.length > 0) {
      summary = agentMessages.at(-1) ?? '';
    }
    if (!summary) {
      summary = result.stdout.trim().split(/\r?\n/).at(-1) ?? '';
    }

    const output = sawJson ? result.stdout : `${result.stdout}\n${result.stderr}`.trim();
    const timedOut = result.timedOut;
    const aborted = result.aborted;

    let error: string | null = null;
    if (result.spawnError) error = result.spawnError;
    else if (aborted) error = '任务已取消';
    else if (timedOut) error = `任务超时（${Math.round(input.timeoutMs / 60_000)} 分钟）`;
    else if (result.code !== 0) {
      error = `Codex 退出码 ${result.code}：${(result.stderr || result.stdout).trim().slice(0, 800)}`;
    }

    return {
      ok: error === null,
      exitCode: result.code,
      summary,
      output,
      durationMs: result.durationMs,
      timedOut,
      aborted,
      error,
      usage,
    };
  }

  private async runClaude(input: EngineRunInput): Promise<EngineRunResult> {
    const settings = this.settings.get();
    const binary = 'claude';
    mkdirSync(input.taskDir, { recursive: true });
    const promptFile = path.join(input.taskDir, 'prompt.md');
    writeFileSync(promptFile, input.prompt, 'utf8');

    const args = [
      '-p',
      input.prompt,
      '--permission-mode',
      'acceptEdits',
      '--output-format',
      'text',
    ];
    if (settings.codexModel) args.push('--model', settings.codexModel);

    input.log('command', `claude -p <prompt> (${input.cwd})`);
    const result = await runCommand(binary, args, {
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onLine: (line) => input.log(line.stream, line.message),
    });

    const output = `${result.stdout}\n${result.stderr}`.trim();
    let error: string | null = null;
    if (result.spawnError) error = `Claude CLI 不可用：${result.spawnError}`;
    else if (result.aborted) error = '任务已取消';
    else if (result.timedOut) error = '任务超时';
    else if (result.code !== 0) error = `Claude 退出码 ${result.code}：${output.slice(0, 800)}`;

    return {
      ok: error === null,
      exitCode: result.code,
      summary: result.stdout.trim(),
      output,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      aborted: result.aborted,
      error,
      usage: null,
    };
  }

  /** Extracts the first JSON object that looks like a review verdict. */
  static parseVerdict(text: string): ReviewVerdict | null {
    const candidates: string[] = [];
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) candidates.push(trimmed);

    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== '{') continue;
      const end = matchJsonObject(text, index);
      if (end === -1) continue;
      const candidate = text.slice(index, end + 1);
      if (candidate.includes('"verdict"')) candidates.push(candidate);
      index = end;
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as Record<string, unknown>;
        const verdictRaw = String(parsed.verdict ?? '').toLowerCase();
        const verdict =
          verdictRaw === 'approve' || verdictRaw === 'approved' || verdictRaw === 'pass'
            ? 'approve'
            : verdictRaw === 'needs_fix' || verdictRaw === 'needs-fix' || verdictRaw === 'fail'
              ? 'needs_fix'
              : null;
        if (!verdict) continue;

        const issuesRaw = Array.isArray(parsed.issues) ? parsed.issues : [];
        const issues: ReviewIssue[] = issuesRaw
          .filter(
            (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
          )
          .map((item) => ({
            severity: normalizeSeverity(item.severity),
            title: String(item.title ?? '未命名问题'),
            detail: String(item.detail ?? ''),
            file: typeof item.file === 'string' ? item.file : undefined,
            line: typeof item.line === 'number' ? item.line : undefined,
            suggestion: typeof item.suggestion === 'string' ? item.suggestion : undefined,
          }));

        return {
          verdict,
          summary: String(parsed.summary ?? ''),
          issues,
          tests: typeof parsed.tests === 'string' ? parsed.tests : undefined,
        };
      } catch {
        // try the next candidate
      }
    }

    const fallback = text.match(/VERDICT\s*[:：]\s*(approve|approved|needs[_-]fix|needs_fix)/i);
    if (fallback) {
      const raw = (fallback[1] ?? '').toLowerCase();
      return {
        verdict: raw.startsWith('approve') ? 'approve' : 'needs_fix',
        summary: text.trim().slice(0, 2000),
        issues: [],
      };
    }
    return null;
  }
}

function normalizeSeverity(value: unknown): ReviewIssue['severity'] {
  const text = String(value ?? '').toLowerCase();
  if (text === 'blocker' || text === 'critical') return 'blocker';
  if (text === 'major' || text === 'high') return 'major';
  return 'minor';
}

/** Finds the index of the `}` closing the object starting at `start`. */
export function matchJsonObject(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function tryParseJsonLines(line: string): ExtractedLine[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const collected: ExtractedLine[] = [];
    walkEvent(parsed, collected, 0, null);
    return collected.filter((entry) => entry.message.trim().length > 0);
  } catch {
    return [];
  }
}

function streamForType(type: string): LogStream {
  const value = type.toLowerCase();
  if (value.includes('error') || value.includes('fail')) return 'stderr';
  if (value.includes('reasoning') || value.includes('thought')) return 'system';
  if (value.includes('command') || value.includes('exec') || value.includes('shell'))
    return 'command';
  if (value.includes('agent') || value.includes('message') || value.includes('assistant'))
    return 'agent';
  return 'stdout';
}

function walkEvent(
  node: unknown,
  out: ExtractedLine[],
  depth: number,
  inherited: LogStream | null,
): void {
  if (depth > MAX_JSON_DEPTH || node === null || node === undefined) return;

  if (Array.isArray(node)) {
    for (const item of node) walkEvent(item, out, depth + 1, inherited);
    return;
  }
  if (typeof node !== 'object') return;

  const record = node as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  const stream = type ? streamForType(type) : inherited;

  const directMessage =
    firstString(record.message) ??
    firstString(record.text) ??
    firstString(record.aggregated_output) ??
    firstString(record.output);

  if (directMessage) {
    out.push({ stream: stream ?? 'stdout', message: directMessage });
  }

  if (Array.isArray(record.command)) {
    const command = record.command.filter((part) => typeof part === 'string').join(' ');
    if (command) out.push({ stream: 'command', message: `$ ${command}` });
  } else if (typeof record.command === 'string' && record.command.trim()) {
    out.push({ stream: 'command', message: `$ ${record.command}` });
  }

  // Recurse into nested payloads that commonly wrap the actual content.
  for (const key of ['msg', 'item', 'delta', 'event', 'data', 'payload', 'error'] as const) {
    if (key in record) walkEvent(record[key], out, depth + 1, stream ?? inherited);
  }
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return null;
}

function extractUsage(line: string): EngineRunResult['usage'] {
  try {
    const parsed = JSON.parse(line.trim()) as unknown;
    const found = findUsage(parsed, 0);
    return found;
  } catch {
    return null;
  }
}

function findUsage(node: unknown, depth: number): EngineRunResult['usage'] {
  if (depth > 5 || node === null || typeof node !== 'object') return null;
  const record = node as Record<string, unknown>;
  const inputTokens = record.input_tokens ?? record.inputTokens;
  const outputTokens = record.output_tokens ?? record.outputTokens;
  if (typeof inputTokens === 'number' || typeof outputTokens === 'number') {
    return {
      inputTokens: typeof inputTokens === 'number' ? inputTokens : null,
      outputTokens: typeof outputTokens === 'number' ? outputTokens : null,
    };
  }
  for (const value of Object.values(record)) {
    const found = findUsage(value, depth + 1);
    if (found) return found;
  }
  return null;
}
