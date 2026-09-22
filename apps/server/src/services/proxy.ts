import {
  DEFAULT_PROXY_GIT_TEST_URL,
  DEFAULT_PROXY_SETTINGS,
  DEFAULT_PROXY_TEST_URL,
  describeResolvedProxy,
  maskProxyUrl,
  normalizeProxyUrl,
  PROXY_PREFERENCE_LABELS,
  PROXY_PREFERENCES,
  PROXY_SLOT_LABELS,
  PROXY_SLOTS,
  type ProxyAccountSummary,
  type ProxyChannelId,
  type ProxyConfigPayload,
  type ProxyMode,
  type ProxyPreference,
  type ProxyProbeCheck,
  type ProxyProbeResult,
  type ProxySettings,
  type ProxySlot,
  type ProxyTestReport,
  type ResolvedProxySummary,
} from '@autogit/shared';

import type { AccountRecord, Store } from '../db/store.js';
import { decryptSecret, encryptSecret } from '../util/crypto.js';
import { describeNetworkError, requestText, responseDetail } from '../util/http-request.js';
import { runCommand } from '../util/subprocess.js';
import { buildGitEnv } from './git.js';

/** Storage key inside the `settings` table. */
const SETTINGS_KEY = 'proxy';

interface StoredProxyConfig {
  settings: ProxySettings;
  /** AES-256-GCM encrypted addresses, one per channel. */
  endpoints: Record<ProxySlot, string | null>;
  updatedAt: string | null;
}

export interface ProxyUpdateInput {
  settings?: Partial<ProxySettings>;
  /** `undefined` keeps the stored address, `null` clears it. */
  endpoints?: Partial<Record<ProxySlot, string | null>>;
}

/** A resolved proxy: the single address an account uses for all targets. */
export interface ResolvedProxy {
  /** `null` means the account talks to the network directly. */
  url: string | null;
  channel: ProxyChannelId;
  label: string;
  summary: ResolvedProxySummary;
}

export interface ProxyTestInput {
  /** Channels to probe; defaults to both channels plus the direct baseline. */
  slots?: ProxySlot[];
  /** Probe the effective proxy of a single account instead of the channels. */
  accountId?: string | null;
  includeGit?: boolean;
  timeoutMs?: number;
  /** Unsaved addresses so the UI can test before saving. */
  draft?: Partial<Record<ProxySlot, string | null>>;
}

interface ProbeTarget {
  key: ProxySlot | 'direct' | 'account';
  label: string;
  url: string | null;
  maskedUrl: string | null;
}

/**
 * Owns the global proxy channels and decides, per account, which address a git
 * or REST call has to use. Addresses are stored encrypted and only ever leave
 * the server masked.
 */
export class ProxyService {
  private cache: StoredProxyConfig | null = null;

  constructor(
    private readonly store: Store,
    private readonly secretKey: Buffer,
  ) {}

  settings(): ProxySettings {
    return this.read().settings;
  }

  /** Decrypted addresses. Never returned through the API. */
  endpoints(): Record<ProxySlot, string | null> {
    const stored = this.read().endpoints;
    return {
      http: this.decrypt(stored.http),
      socks5: this.decrypt(stored.socks5),
    };
  }

  /** Encrypts a proxy address before it is persisted (settings or account). */
  encryptEndpoint(plain: string): string {
    return encryptSecret(plain, this.secretKey);
  }

  /** Decrypts a stored proxy address, `null` when unreadable. */
  decryptEndpoint(value: string | null | undefined): string | null {
    return this.decrypt(value ?? null);
  }

  update(input: ProxyUpdateInput): void {
    const current = this.read();
    const next: StoredProxyConfig = {
      settings: normalizeSettings({ ...current.settings, ...input.settings }),
      endpoints: { ...current.endpoints },
      updatedAt: new Date().toISOString(),
    };

    for (const slot of PROXY_SLOTS) {
      const value = input.endpoints?.[slot];
      if (value === undefined) continue;
      const trimmed = value?.trim() ?? '';
      next.endpoints[slot] =
        trimmed.length === 0 ? null : encryptSecret(normalizeProxyUrl(trimmed), this.secretKey);
    }

    this.store.setSetting(SETTINGS_KEY, JSON.stringify(next));
    this.cache = next;
  }

  /**
   * Resolves the address an account has to use. `customUrl` is the plain
   * address of an account level override (only relevant for `custom`).
   */
  resolve(mode: ProxyMode, customUrl: string | null): ResolvedProxy {
    const settings = this.settings();
    if (!settings.enabled) return this.build('disabled', null);

    const endpoints = this.endpoints();

    // `inherit` follows the global default channel (HTTP(S), SOCKS5 or direct).
    const target: ProxyMode = mode === 'inherit' ? settings.preferred : mode;

    switch (target) {
      case 'direct':
        return this.build('direct', null);
      case 'custom': {
        const url = customUrl?.trim() ? customUrl.trim() : null;
        return url ? this.build('custom', url) : this.build('direct', null);
      }
      case 'socks5': {
        const url = pick(endpoints, 'socks5');
        return url ? this.build('socks5', url) : this.build('direct', null);
      }
      default: {
        // http: the merged HTTP(S) channel, with SOCKS5 as fallback so a
        // single configured address already routes everything.
        const url = pick(endpoints, 'http');
        return url ? this.build('http', url) : this.build('direct', null);
      }
    }
  }

  resolveForAccount(account: Pick<AccountRecord, 'proxyMode' | 'proxyUrlEnc'>): ResolvedProxy {
    return this.resolve(account.proxyMode, this.decrypt(account.proxyUrlEnc));
  }

  view(): ProxyConfigPayload {
    const endpoints = this.endpoints();
    const summaryFor = (url: string | null): { configured: boolean; maskedUrl: string | null } => ({
      configured: Boolean(url),
      maskedUrl: maskProxyUrl(url),
    });

    return {
      settings: this.settings(),
      endpoints: {
        http: summaryFor(endpoints.http),
        socks5: summaryFor(endpoints.socks5),
      },
      defaultProxy: this.resolve('inherit', null).summary,
      updatedAt: this.read().updatedAt,
      accounts: this.store.listAccounts().map((account): ProxyAccountSummary => {
        const resolved = this.resolveForAccount(account);
        return {
          id: account.id,
          name: account.name,
          provider: account.provider,
          proxyMode: account.proxyMode,
          proxyMaskedUrl: maskProxyUrl(this.decrypt(account.proxyUrlEnc)),
          effective: resolved.summary,
        };
      }),
    };
  }

  /** Human readable one liner used for activity entries. */
  describeUpdate(input: ProxyUpdateInput): string {
    const settings = this.settings();
    const endpoints = this.endpoints();
    const slots = PROXY_SLOTS.filter((slot) => input.endpoints?.[slot] !== undefined).map(
      (slot) => `${PROXY_SLOT_LABELS[slot]}${endpoints[slot] ? '已设置' : '已清除'}`,
    );
    const state = settings.enabled ? '启用' : '停用';
    const parts = [`代理总开关${state}`, `默认通道 ${PROXY_PREFERENCE_LABELS[settings.preferred]}`];
    return `更新代理配置（${parts.join('，')}${slots.length > 0 ? `，${slots.join('、')}` : ''}）`;
  }

  /**
   * Probes the configured channels (or one account) against GitHub: a REST
   * request plus, optionally, a real `git ls-remote` through the same proxy.
   */
  async test(input: ProxyTestInput = {}): Promise<ProxyTestReport> {
    const settings = this.settings();
    const timeoutMs = input.timeoutMs ?? settings.testTimeoutMs;
    const startedAt = new Date().toISOString();
    const started = Date.now();

    const probes = this.buildProbes(input, { ...this.endpoints() });
    const results = await Promise.all(
      probes.map((probe) =>
        this.probe(probe, {
          testUrl: settings.testUrl,
          gitTestUrl: settings.gitTestUrl,
          timeoutMs,
          includeGit: input.includeGit !== false,
        }),
      ),
    );

    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      results,
    };
  }

  private buildProbes(
    input: ProxyTestInput,
    endpoints: Record<ProxySlot, string | null>,
  ): ProbeTarget[] {
    for (const slot of PROXY_SLOTS) {
      const draft = input.draft?.[slot];
      if (draft === undefined) continue;
      const trimmed = draft?.trim() ?? '';
      endpoints[slot] = trimmed.length === 0 ? null : normalizeProxyUrl(trimmed);
    }

    if (input.accountId) {
      const account = this.store.getAccount(input.accountId);
      if (!account) throw new Error('账号不存在');
      const resolved = this.resolveForAccount(account);
      return [
        {
          key: 'account',
          label: `账号「${account.name}」`,
          url: resolved.url,
          maskedUrl: resolved.label,
        },
      ];
    }

    const explicit = Boolean(input.slots && input.slots.length > 0);
    const slots =
      input.slots && input.slots.length > 0
        ? PROXY_SLOTS.filter((slot) => input.slots?.includes(slot))
        : [...PROXY_SLOTS];

    const probes: ProbeTarget[] = [
      {
        key: 'direct',
        label: '直连（不使用代理）',
        url: null,
        maskedUrl: null,
      },
    ];
    for (const slot of slots) {
      const url = endpoints[slot];
      // When every channel is probed, an unconfigured one is simply skipped:
      // the other channels already fall back to whatever is configured.
      if (!url && !explicit) continue;
      probes.push({
        key: slot,
        label: PROXY_SLOT_LABELS[slot],
        url,
        maskedUrl: maskProxyUrl(url),
      });
    }
    return probes;
  }

  private async probe(
    probe: ProbeTarget,
    options: {
      testUrl: string;
      gitTestUrl: string;
      timeoutMs: number;
      includeGit: boolean;
    },
  ): Promise<ProxyProbeResult> {
    const checks: ProxyProbeCheck[] = [];
    const proxyUrl = probe.url;
    const missingSlot = !proxyUrl && !probe.maskedUrl && probe.key !== 'direct';

    if (missingSlot) {
      checks.push({
        id: 'api',
        label: 'REST API',
        ok: false,
        status: null,
        latencyMs: null,
        message: '尚未配置该代理地址',
      });
      return {
        target: probe.key,
        label: probe.label,
        maskedUrl: probe.maskedUrl,
        ok: false,
        checks,
      };
    }

    checks.push(await this.checkApi(options.testUrl, proxyUrl, options.timeoutMs));
    if (options.includeGit) {
      checks.push(await this.checkGit(options.gitTestUrl, proxyUrl, options.timeoutMs));
    }

    return {
      target: probe.key,
      label: probe.label,
      maskedUrl: probe.maskedUrl,
      ok: checks.every((check) => check.ok),
      checks,
    };
  }

  private async checkApi(
    url: string,
    proxyUrl: string | null,
    timeoutMs: number,
  ): Promise<ProxyProbeCheck> {
    const started = Date.now();
    const label = 'GitHub REST API';
    try {
      const response = await requestText({
        url,
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'autogit/0.1' },
        timeoutMs,
        proxyUrl,
      });
      const ok = response.status >= 200 && response.status < 400;
      const detail = ok ? null : responseDetail(response.body);
      return {
        id: 'api',
        label,
        ok,
        status: response.status,
        latencyMs: Date.now() - started,
        message: ok ? null : `HTTP ${response.status}${detail ? `：${detail}` : ''}`,
      };
    } catch (error) {
      return {
        id: 'api',
        label,
        ok: false,
        status: null,
        latencyMs: Date.now() - started,
        message: describeNetworkError(error, timeoutMs),
      };
    }
  }

  private async checkGit(
    url: string,
    proxyUrl: string | null,
    timeoutMs: number,
  ): Promise<ProxyProbeCheck> {
    const started = Date.now();
    const label = 'git ls-remote';
    // `git ls-remote` is the slow part (DNS + TLS + ref advertisement), so it
    // gets a longer budget than the REST probe; users on a flaky link would
    // otherwise only ever see "timeout" instead of "works, slowly".
    const gitTimeoutMs = Math.min(Math.max(timeoutMs * 3, 15_000), 60_000);
    const result = await runCommand('git', ['ls-remote', '--exit-code', url, 'HEAD'], {
      env: buildGitEnv({ proxy: { url: proxyUrl } }),
      timeoutMs: gitTimeoutMs,
    });
    const latencyMs = Date.now() - started;

    if (result.code === 0) {
      return { id: 'git', label, ok: true, status: null, latencyMs, message: null };
    }
    if (result.spawnError) {
      return {
        id: 'git',
        label,
        ok: false,
        status: null,
        latencyMs,
        message: `未检测到 git：${result.spawnError}`,
      };
    }
    const text = firstLine(result.stderr) || firstLine(result.stdout);
    return {
      id: 'git',
      label,
      ok: false,
      status: null,
      latencyMs,
      message: result.timedOut
        ? `git 命令超时（${Math.round(gitTimeoutMs / 1000)}s）`
        : text || `git 退出码 ${result.code}`,
    };
  }

  private build(channel: ProxyChannelId, url: string | null): ResolvedProxy {
    const summary: ResolvedProxySummary = {
      channel,
      label: '',
      maskedUrl: maskProxyUrl(url),
    };
    summary.label = describeResolvedProxy(summary);
    return { url, channel, label: summary.label, summary };
  }

  private decrypt(value: string | null): string | null {
    if (!value) return null;
    try {
      return decryptSecret(value, this.secretKey);
    } catch {
      return null;
    }
  }

  private read(): StoredProxyConfig {
    if (this.cache) return this.cache;

    const fallback: StoredProxyConfig = {
      settings: { ...DEFAULT_PROXY_SETTINGS },
      endpoints: { http: null, socks5: null },
      updatedAt: null,
    };
    const stored = this.store.allSettings()[SETTINGS_KEY];
    if (!stored) {
      this.cache = fallback;
      return fallback;
    }

    try {
      const parsed = JSON.parse(stored) as Partial<StoredProxyConfig>;
      // `https` keeps the value written by versions that had separate HTTP and
      // HTTPS channels: it is merged into the HTTP(S) channel (and preferred,
      // because it was the address proven to carry CONNECT tunnels).
      const endpoints = (parsed.endpoints ?? {}) as Partial<
        Record<ProxySlot | 'https', string | null>
      >;
      this.cache = {
        settings: normalizeSettings(parsed.settings),
        endpoints: {
          http: readString(endpoints.https) ?? readString(endpoints.http),
          socks5: readString(endpoints.socks5),
        },
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      };
    } catch {
      this.cache = fallback;
    }
    return this.cache;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Chooses the address for one channel. Either channel can serve both target
 * schemes, so an empty one simply falls back to the other: configuring a
 * single address is enough to route all traffic, which is what users with one
 * local proxy port expect.
 */
function pick(endpoints: Record<ProxySlot, string | null>, slot: ProxySlot): string | null {
  const order: Readonly<Record<ProxySlot, readonly ProxySlot[]>> = {
    http: ['http', 'socks5'],
    socks5: ['socks5', 'http'],
  };
  for (const candidate of order[slot]) {
    const url = endpoints[candidate];
    if (url) return url;
  }
  return null;
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function httpUrlOr(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function normalizeSettings(value: Partial<ProxySettings> | undefined): ProxySettings {
  const merged = { ...DEFAULT_PROXY_SETTINGS, ...(value ?? {}) };
  // `auto` and `https` come from the version with separate HTTP/HTTPS
  // channels; both now mean "use the merged HTTP(S) channel".
  const legacy = merged.preferred as string;
  const preferred: ProxyPreference =
    legacy === 'auto' || legacy === 'https'
      ? 'http'
      : PROXY_PREFERENCES.includes(merged.preferred)
        ? merged.preferred
        : DEFAULT_PROXY_SETTINGS.preferred;
  const timeout = Number(merged.testTimeoutMs);

  return {
    enabled: merged.enabled === true,
    preferred,
    testUrl: httpUrlOr(merged.testUrl, DEFAULT_PROXY_TEST_URL),
    gitTestUrl: httpUrlOr(merged.gitTestUrl, DEFAULT_PROXY_GIT_TEST_URL),
    testTimeoutMs: Number.isFinite(timeout)
      ? clamp(Math.round(timeout), 2_000, 60_000)
      : DEFAULT_PROXY_SETTINGS.testTimeoutMs,
  };
}
