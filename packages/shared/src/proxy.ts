/**
 * Proxy configuration shared by the server and the web UI.
 *
 * AutoGit manages two proxy channels:
 *   - `http`   — one HTTP(S) proxy used for `http://` targets (absolute form
 *                forwarding) and `https://` targets (`CONNECT` tunnel) alike
 *   - `socks5` — the same for both schemes, and the fallback of `http`
 *
 * Every channel accepts an `http://`, `https://`, `socks5://` or `socks5h://`
 * address; the scheme describes how AutoGit talks to the proxy itself.
 *
 * Everything here is dependency free (no Node built-ins) so the browser can
 * validate and preview proxy addresses with exactly the same rules the server
 * applies when it stores them.
 */

/** Global proxy channel. `http` covers plain HTTP and HTTPS targets alike. */
export type ProxySlot = 'http' | 'socks5';

/** Channel used by accounts that stay on `inherit`. */
export type ProxyPreference = ProxySlot | 'direct';

/** Per account proxy selection. */
export type ProxyMode = 'inherit' | 'direct' | 'http' | 'socks5' | 'custom';

/** Channel that ended up being used once everything was resolved. */
export type ProxyChannelId = ProxySlot | 'direct' | 'custom' | 'disabled';

export const PROXY_SLOTS: readonly ProxySlot[] = ['http', 'socks5'];

export const PROXY_MODES: readonly ProxyMode[] = ['inherit', 'direct', 'http', 'socks5', 'custom'];

export const PROXY_PREFERENCES: readonly ProxyPreference[] = ['http', 'socks5', 'direct'];

export const PROXY_SCHEMES = ['http', 'https', 'socks5', 'socks5h'] as const;
export type ProxyScheme = (typeof PROXY_SCHEMES)[number];

export const PROXY_MODE_LABELS: Readonly<Record<ProxyMode, string>> = {
  inherit: '继承全局默认',
  direct: '直连（不使用代理）',
  http: '仅用全局 HTTP(S) 代理',
  socks5: '仅用全局 SOCKS5 代理',
  custom: '账号单独代理',
};

export const PROXY_PREFERENCE_LABELS: Readonly<Record<ProxyPreference, string>> = {
  http: 'HTTP(S) 代理',
  socks5: 'SOCKS5 代理',
  direct: '直连',
};

export const PROXY_SLOT_LABELS: Readonly<Record<ProxySlot, string>> = {
  http: 'HTTP(S) 代理',
  socks5: 'SOCKS5 代理',
};

export const DEFAULT_PROXY_TEST_URL = 'https://api.github.com/';
export const DEFAULT_PROXY_GIT_TEST_URL = 'https://github.com/octocat/Hello-World.git';

/**
 * Structural view of the WHATWG URL class. Declared locally because the shared
 * package is compiled without the DOM (web) and without `@types/node` (server)
 * libraries; `globalThis.URL` exists in both runtimes.
 */
interface ParsedUrl {
  protocol: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  username: string;
  password: string;
  toString(): string;
}

const UrlClass = (globalThis as unknown as { URL: new (input: string, base?: string) => ParsedUrl })
  .URL;

function parseUrl(input: string, base?: string): ParsedUrl | null {
  try {
    return base ? new UrlClass(input, base) : new UrlClass(input);
  } catch {
    return null;
  }
}

export interface ProxySettings {
  /** Master switch: when off, every account talks to the network directly. */
  enabled: boolean;
  /** Channel used by accounts that keep `inherit`. */
  preferred: ProxyPreference;
  /** HTTP endpoint probed by the connectivity test. */
  testUrl: string;
  /** Git remote used by the `git ls-remote` part of the connectivity test. */
  gitTestUrl: string;
  /** Timeout applied to each probe request. */
  testTimeoutMs: number;
}

export const DEFAULT_PROXY_SETTINGS: ProxySettings = {
  enabled: false,
  preferred: 'http',
  testUrl: DEFAULT_PROXY_TEST_URL,
  gitTestUrl: DEFAULT_PROXY_GIT_TEST_URL,
  testTimeoutMs: 10_000,
};

/** A proxy address after parsing, with the credentials split out. */
export interface ParsedProxyUrl {
  scheme: ProxyScheme;
  /** Host without IPv6 brackets — usable by `net.connect`. */
  host: string;
  port: number;
  username: string;
  password: string;
  /** `scheme://host:port`, credentials removed. */
  origin: string;
  /** Normalized address including credentials, this is what gets stored. */
  url: string;
  /** `socks5h://` asks the proxy to resolve the target host name. */
  remoteDns: boolean;
}

const DEFAULT_PORTS: Readonly<Record<ProxyScheme, number>> = {
  http: 80,
  https: 443,
  socks5: 1080,
  socks5h: 1080,
};

function isProxyScheme(value: string): value is ProxyScheme {
  return (PROXY_SCHEMES as readonly string[]).includes(value);
}

/**
 * Parses `http://user:pass@127.0.0.1:7890` (also accepts `127.0.0.1:7890` and
 * `socks5h://…`). Throws with a user facing Chinese message when the address
 * cannot be used.
 */
export function parseProxyUrl(raw: string): ParsedProxyUrl {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) throw new Error('代理地址不能为空');

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;

  const parsed = parseUrl(withScheme);
  if (!parsed) {
    throw new Error(`无法解析代理地址：${trimmed}（示例：http://127.0.0.1:7890）`);
  }

  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  if (!isProxyScheme(scheme)) {
    throw new Error(`不支持的代理协议：${scheme}（仅支持 http / https / socks5 / socks5h）`);
  }

  if (!parsed.hostname) throw new Error('代理地址缺少主机名');

  const path = parsed.pathname.replace(/\/+$/, '');
  if (path.length > 0) throw new Error('代理地址不应包含路径');

  const port = parsed.port ? Number.parseInt(parsed.port, 10) : DEFAULT_PORTS[scheme];
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`代理端口无效：${parsed.port}`);
  }

  const username = safeDecode(parsed.username);
  const password = safeDecode(parsed.password);
  const auth =
    username.length > 0 || password.length > 0
      ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
      : '';
  const authority = `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;

  return {
    scheme,
    host: parsed.hostname.replace(/^\[|\]$/g, ''),
    port,
    username,
    password,
    origin: `${scheme}://${authority}`,
    url: `${scheme}://${auth}${authority}`,
    remoteDns: scheme === 'socks5h',
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Normalizes user input and validates it; returns the address to store. */
export function normalizeProxyUrl(raw: string): string {
  return parseProxyUrl(raw).url;
}

/**
 * Masks the password inside a proxy address so the value can be shown in the
 * UI and returned by the API without leaking a credential.
 */
export function maskProxyUrl(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return null;
  let parsed: ParsedProxyUrl;
  try {
    parsed = parseProxyUrl(trimmed);
  } catch {
    return trimmed;
  }
  const user = parsed.username;
  const secret = parsed.password;
  if (user.length === 0 && secret.length === 0) return parsed.url;

  const encodedUser = user.length > 0 ? encodeURIComponent(user) : '';
  const auth = `${encodedUser}${secret.length > 0 ? ':••••' : ''}@`;
  const authority = parsed.url.slice(parsed.url.indexOf('@') + 1);
  return `${parsed.scheme}://${auth}${authority}`;
}

export interface ProxyEndpointSummary {
  configured: boolean;
  /** Masked address, safe to render. */
  maskedUrl: string | null;
}

export interface ResolvedProxySummary {
  channel: ProxyChannelId;
  label: string;
  /** Masked address this account uses, `null` means direct. */
  maskedUrl: string | null;
}

export interface ProxyProbeCheck {
  id: 'api' | 'git';
  label: string;
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  message: string | null;
}

export interface ProxyProbeResult {
  target: ProxySlot | 'direct' | 'account';
  label: string;
  maskedUrl: string | null;
  ok: boolean;
  checks: ProxyProbeCheck[];
}

export interface ProxyTestReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  results: ProxyProbeResult[];
}

/** Short Chinese description of a resolved proxy, used by chips and logs. */
export function describeResolvedProxy(summary: ResolvedProxySummary): string {
  switch (summary.channel) {
    case 'disabled':
      return '代理已停用（直连）';
    case 'direct':
      return '直连';
    case 'custom':
      return summary.maskedUrl ?? '账号代理（未配置）';
    default:
      return summary.maskedUrl ?? PROXY_SLOT_LABELS[summary.channel];
  }
}
