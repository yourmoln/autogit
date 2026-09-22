import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type {
  CodexCapabilities,
  CodexConfigPayload,
  CodexInstallState,
  CodexModelProbe,
  CodexStatus,
  LogStream,
} from '@autogit/shared';
import { parse as parseToml } from 'smol-toml';

import type { RuntimeConfig } from '../config.js';
import { childLogger } from '../util/logger.js';
import { clearExecutableCache, runCommand, whichCommand } from '../util/subprocess.js';
import { nowIso } from '../util/time.js';
import type { EventBus } from './events.js';
import type { SettingsService } from './settings.js';

const CAPABILITY_TTL_MS = 5 * 60_000;
/** A probe costs one tiny model call, so a fresh result is reused for a while. */
const PROBE_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 3 * 60_000;
const LOG_RING_SIZE = 400;
const CONFIG_BACKUP_KEEP = 10;

interface CapabilityCache {
  at: number;
  capabilities: CodexCapabilities;
}

interface ProbeCache {
  at: number;
  probe: CodexModelProbe;
}

/** Trivial prompt: the probe only answers "can this model respond at all". */
const PROBE_PROMPT = '这是 AutoGit 的模型连通性探测。请只回复 pong，不要调用任何工具。';

export const DEFAULT_CONFIG_TEMPLATE = `# Codex CLI 配置（由 AutoGit 编辑，保存前会自动备份原文件）

model = "gpt-5-codex"
model_reasoning_effort = "medium"
approval_policy = "never"
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true
`;

export class CodexService {
  private readonly log = childLogger('codex');
  private capabilityCache: CapabilityCache | null = null;
  private probeCache: ProbeCache | null = null;
  private installState: CodexInstallState = {
    running: false,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    command: null,
    lines: [],
  };
  private installPromise: Promise<void> | null = null;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly settings: SettingsService,
    private readonly events: EventBus,
  ) {}

  get configPath(): string {
    return path.join(this.config.codexHome, 'config.toml');
  }

  private get backupDir(): string {
    return path.join(this.config.codexHome, 'autogit-backups');
  }

  resolveBinary(): { path: string | null; source: CodexStatus['source'] } {
    const configured = this.settings.get().codexPath;
    if (configured && existsSync(configured)) {
      return { path: configured, source: 'configured' };
    }
    const discovered = whichCommand('codex');
    if (discovered) return { path: discovered, source: 'path' };
    return { path: null, source: 'missing' };
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, CODEX_HOME: this.config.codexHome };
  }

  async version(): Promise<string | null> {
    const { path: binary } = this.resolveBinary();
    if (!binary) return null;
    const result = await runCommand(binary, ['--version'], { env: this.env(), timeoutMs: 20_000 });
    if (result.code !== 0) return null;
    const output = result.stdout.trim();
    const match = output.match(/codex-cli\s+(\S+)/) ?? output.match(/(\d+\.\d+\.\d+\S*)/);
    return match ? (match[1] ?? null) : output || null;
  }

  async capabilities(force = false): Promise<CodexCapabilities | null> {
    if (
      !force &&
      this.capabilityCache &&
      Date.now() - this.capabilityCache.at < CAPABILITY_TTL_MS
    ) {
      return this.capabilityCache.capabilities;
    }
    const { path: binary } = this.resolveBinary();
    if (!binary) return null;

    const result = await runCommand(binary, ['exec', '--help'], {
      env: this.env(),
      timeoutMs: 20_000,
    });
    const help = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0 && help.trim().length === 0) return null;

    const capabilities: CodexCapabilities = {
      execCommand: result.code === 0,
      jsonOutput: help.includes('--json'),
      sandboxFlag: help.includes('--sandbox'),
      configOverride: help.includes('--config'),
      cdFlag: help.includes('--cd'),
      skipGitRepoCheck: help.includes('--skip-git-repo-check'),
      modelFlag: help.includes('--model'),
      outputLastMessage: help.includes('--output-last-message'),
      outputSchema: help.includes('--output-schema'),
      ephemeral: help.includes('--ephemeral'),
      reviewSubcommand: /Run a code review/.test(help),
      updateSubcommand: false,
      raw: help.slice(0, 6000),
    };

    const rootHelp = await runCommand(binary, ['--help'], { env: this.env(), timeoutMs: 20_000 });
    capabilities.updateSubcommand = /(^|\s)update(\s|$)/m.test(
      `${rootHelp.stdout}\n${rootHelp.stderr}`,
    );

    this.capabilityCache = { at: Date.now(), capabilities };
    return capabilities;
  }

  /**
   * Live check that the model actually answers: one minimal `codex exec` call
   * with a trivial prompt, run in a read-only sandbox against a scratch
   * directory. AutoGit never inspects or manages credentials — the CLI owns
   * them, this probe only looks at whether the model replied.
   */
  async modelProbe(force = false): Promise<CodexModelProbe> {
    if (!force && this.probeCache && Date.now() - this.probeCache.at < PROBE_TTL_MS) {
      return this.probeCache.probe;
    }

    const { path: binary } = this.resolveBinary();
    const checkedAt = nowIso();
    if (!binary) {
      return this.cacheProbe({
        ready: null,
        message: '未检测到 codex 命令，请安装或手动指定可执行文件路径。',
        durationMs: null,
        checkedAt,
      });
    }

    const capabilities = await this.capabilities();
    if (capabilities && !capabilities.execCommand) {
      return this.cacheProbe({
        ready: false,
        message: 'codex exec 不可用，当前版本可能过旧。',
        durationMs: null,
        checkedAt,
      });
    }

    const settings = this.settings.get();
    // `dataDir` is guaranteed to exist once the runtime is up; falling back to
    // the install directory keeps the probe usable in bare setups.
    const cwd = existsSync(this.config.dataDir) ? this.config.dataDir : this.config.repoRoot;
    const args = ['exec'];
    if (settings.codexModel && capabilities?.modelFlag) args.push('--model', settings.codexModel);
    // Read-only: the probe must never be able to touch the user's files.
    if (capabilities?.sandboxFlag) args.push('--sandbox', 'read-only');
    if (capabilities?.cdFlag) args.push('--cd', cwd);
    if (capabilities?.skipGitRepoCheck) args.push('--skip-git-repo-check');
    if (capabilities?.ephemeral) args.push('--ephemeral');
    if (capabilities?.configOverride) args.push('-c', 'approval_policy="never"');
    args.push('-');

    const result = await runCommand(binary, args, {
      cwd,
      env: this.env(),
      input: PROBE_PROMPT,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();

    if (result.spawnError) {
      return this.cacheProbe({
        ready: false,
        message: excerpt(result.spawnError),
        durationMs: result.durationMs,
        checkedAt,
      });
    }
    if (result.timedOut) {
      return this.cacheProbe({
        ready: false,
        message: `探测超时（${Math.round(PROBE_TIMEOUT_MS / 1000)}s），模型没有在限定时间内响应。`,
        durationMs: result.durationMs,
        checkedAt,
      });
    }
    if (result.code !== 0) {
      return this.cacheProbe({
        ready: false,
        message: `codex exec 失败（退出码 ${result.code ?? 'null'}）：${
          excerpt(stderr || stdout) || '没有输出'
        }`,
        durationMs: result.durationMs,
        checkedAt,
      });
    }
    if (stdout.length === 0) {
      return this.cacheProbe({
        ready: false,
        message: 'codex exec 正常退出，但模型没有返回任何内容。',
        durationMs: result.durationMs,
        checkedAt,
      });
    }

    const answer = modelAnswer(stdout);
    this.log.info({ durationMs: result.durationMs }, 'codex model probe succeeded');
    return this.cacheProbe({
      ready: true,
      message: answer ? excerpt(answer, 200) : null,
      durationMs: result.durationMs,
      checkedAt,
    });
  }

  private cacheProbe(probe: CodexModelProbe): CodexModelProbe {
    this.probeCache = { at: Date.now(), probe };
    return probe;
  }

  async status(options: { force?: boolean } = {}): Promise<CodexStatus> {
    const { path: binary, source } = this.resolveBinary();
    const configExists = existsSync(this.configPath);
    const checkedAt = nowIso();
    const modelProbe = this.probeCache?.probe ?? null;

    if (!binary) {
      return {
        installed: false,
        binaryPath: null,
        version: null,
        source: 'missing',
        configPath: this.configPath,
        configExists,
        capabilities: null,
        modelProbe,
        checkedAt,
        warning: null,
      };
    }

    const [version, capabilities] = await Promise.all([
      this.version(),
      this.capabilities(options.force ?? false),
    ]);

    let warning: string | null = null;
    if (!version) warning = 'codex --version 执行失败，请检查安装是否完整。';
    else if (capabilities && !capabilities.execCommand) {
      warning = 'codex exec 不可用，当前版本可能过旧。';
    }

    return {
      installed: true,
      binaryPath: binary,
      version,
      source,
      configPath: this.configPath,
      configExists,
      capabilities,
      modelProbe,
      checkedAt,
      warning,
    };
  }

  readConfig(): CodexConfigPayload {
    const exists = existsSync(this.configPath);
    const content = exists ? readFileSync(this.configPath, 'utf8') : DEFAULT_CONFIG_TEMPLATE;
    let parsed: Record<string, unknown> | null = null;
    let parseError: string | null = null;

    try {
      parsed = content.trim().length > 0 ? (parseToml(content) as Record<string, unknown>) : {};
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }

    const pick = (key: string): string | null => {
      const value = parsed?.[key];
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return null;
    };

    return {
      path: this.configPath,
      content,
      parsed,
      parseError,
      highlights: {
        model: pick('model'),
        modelReasoningEffort: pick('model_reasoning_effort'),
        approvalPolicy: pick('approval_policy'),
        sandboxMode: pick('sandbox_mode'),
      },
    };
  }

  writeConfig(content: string): CodexConfigPayload {
    // Validate before writing: a broken config.toml would break every run.
    parseToml(content);
    mkdirSync(this.config.codexHome, { recursive: true });

    if (existsSync(this.configPath)) {
      mkdirSync(this.backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      copyFileSync(this.configPath, path.join(this.backupDir, `config-${stamp}.toml`));
      this.pruneBackups();
    }

    writeFileSync(this.configPath, content, 'utf8');
    this.log.info({ path: this.configPath }, 'codex config.toml updated');
    return this.readConfig();
  }

  listConfigBackups(): Array<{ name: string; createdAt: string; size: number }> {
    if (!existsSync(this.backupDir)) return [];
    return readdirSync(this.backupDir)
      .filter((name) => name.endsWith('.toml'))
      .map((name) => {
        const stats = statSync(path.join(this.backupDir, name));
        return { name, createdAt: stats.mtime.toISOString(), size: stats.size };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20);
  }

  private pruneBackups(keep = CONFIG_BACKUP_KEEP): void {
    if (!existsSync(this.backupDir)) return;
    const files = readdirSync(this.backupDir)
      .filter((name) => name.endsWith('.toml'))
      .map((name) => ({ name, mtime: statSync(path.join(this.backupDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const file of files.slice(keep)) {
      try {
        rmSync(path.join(this.backupDir, file.name), { force: true });
      } catch {
        // backup pruning is best effort
      }
    }
  }

  getInstallState(): CodexInstallState {
    return { ...this.installState, lines: [...this.installState.lines] };
  }

  isInstalling(): boolean {
    return this.installState.running;
  }

  async installOrUpdate(): Promise<CodexInstallState> {
    if (this.installPromise) {
      await this.installPromise;
      return this.getInstallState();
    }

    const { path: binary } = this.resolveBinary();
    const capabilities = binary ? await this.capabilities(true) : null;

    let command: string;
    let args: string[];
    if (binary && capabilities?.updateSubcommand) {
      command = binary;
      args = ['update'];
    } else {
      command = this.resolvePackageManager();
      args = ['install', '-g', '@openai/codex@latest'];
    }

    this.installState = {
      running: true,
      startedAt: nowIso(),
      finishedAt: null,
      exitCode: null,
      command: `${command} ${args.join(' ')}`,
      lines: [],
    };
    this.publishInstallState();

    const push = (stream: LogStream, message: string): void => {
      this.installState.lines.push({ ts: nowIso(), stream, message });
      if (this.installState.lines.length > LOG_RING_SIZE) this.installState.lines.shift();
      this.publishInstallState();
    };
    push('system', `执行：${command} ${args.join(' ')}`);

    this.installPromise = (async () => {
      const result = await runCommand(command, args, {
        env: this.env(),
        timeoutMs: 15 * 60_000,
        onLine: (line) => {
          if (line.message.trim().length > 0) push(line.stream, line.message);
        },
      });

      this.installState.running = false;
      this.installState.finishedAt = nowIso();
      this.installState.exitCode = result.code;
      push(
        result.code === 0 ? 'system' : 'stderr',
        result.code === 0 ? '安装/更新完成' : `安装失败（退出码 ${result.code ?? 'null'}）`,
      );

      clearExecutableCache();
      this.capabilityCache = null;
      this.probeCache = null;
      this.installPromise = null;
      this.publishInstallState();
    })();

    await this.installPromise;
    return this.getInstallState();
  }

  private resolvePackageManager(): string {
    const npm = whichCommand('npm');
    if (npm) return npm;
    const pnpm = whichCommand('pnpm');
    if (pnpm) return pnpm;
    throw new Error('未找到 npm / pnpm，无法自动安装 Codex CLI，请手动安装后重试。');
  }

  private publishInstallState(): void {
    this.events.emit({ type: 'codex.install', state: this.getInstallState() });
  }

  invalidate(): void {
    this.capabilityCache = null;
    this.probeCache = null;
    clearExecutableCache();
  }
}

/**
 * `codex exec` prints a short footer (separators, a "tokens used" block and
 * counters) after the agent message; skip that noise when picking the answer.
 */
function modelAnswer(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !/^-+$/.test(line) &&
        !/^tokens used$/i.test(line) &&
        !/^[\d.,\s]+$/.test(line),
    );
  return lines.at(-1) ?? '';
}

function excerpt(text: string, maxChars = 400): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  // Keep the tail: CLI failures end with the actionable error, the head is
  // usually just startup banner / warning noise.
  return cleaned.length > maxChars ? `…${cleaned.slice(-maxChars)}` : cleaned;
}
