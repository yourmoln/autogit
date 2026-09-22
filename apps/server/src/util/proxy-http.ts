/**
 * Minimal, dependency free HTTP client that can reach an `http://`/`https://`
 * target through an HTTP(S) proxy (CONNECT) or a SOCKS5 proxy.
 *
 * It is only used when a proxy is configured; without one the server keeps
 * using the platform `fetch`, so the default code path stays untouched.
 */
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import { type Socket, connect as tcpConnect } from 'node:net';
import type { Duplex } from 'node:stream';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

import { type ParsedProxyUrl, parseProxyUrl } from '@autogit/shared';

export type ProxyErrorKind = 'proxy' | 'target' | 'timeout' | 'invalid';

/** Failure raised by the proxy layer, with a message meant for the UI. */
export class ProxyRequestError extends Error {
  constructor(
    readonly kind: ProxyErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ProxyRequestError';
  }
}

export interface ProxyHttpInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | null;
  timeoutMs?: number;
  proxyUrl: string;
  maxRedirects?: number;
}

export interface ProxyHttpResponse {
  status: number;
  /** Lower cased header names. */
  headers: Record<string, string>;
  body: string;
  /** Final URL after redirects. */
  url: string;
}

const DEFAULT_TIMEOUT = 30_000;
const MAX_REDIRECTS = 4;
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

const SOCKS_REPLY_MESSAGES: Readonly<Record<number, string>> = {
  1: 'SOCKS5 代理内部错误',
  2: 'SOCKS5 代理拒绝了连接（规则不允许）',
  3: 'SOCKS5 代理无法访问目标网络',
  4: 'SOCKS5 代理无法解析目标主机',
  5: 'SOCKS5 代理连接目标被拒绝',
  6: 'SOCKS5 代理连接目标超时',
  7: 'SOCKS5 代理不支持该命令',
  8: 'SOCKS5 代理不支持该地址类型',
};

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * A no-op `error` listener keeps a socket that is being handed over to
 * `http.ClientRequest` from crashing the process when it fails in between.
 */
function guardErrors(socket: Socket): Socket {
  socket.on('error', () => undefined);
  return socket;
}

function dialTcp(
  host: string,
  port: number,
  timeoutMs: number,
  kind: ProxyErrorKind,
  label: string,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = tcpConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ProxyRequestError('timeout', `${label} 超时（${timeoutMs}ms）`));
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(guardErrors(socket));
    });
    socket.once('error', (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new ProxyRequestError(kind, `${label} 失败：${error.message}`));
    });
  });
}

function wrapTls(
  socket: Socket,
  host: string,
  timeoutMs: number,
  label: string,
): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const tlsSocket = tlsConnect({
      socket,
      servername: isIpLiteral(host) ? undefined : host,
      ALPNProtocols: ['http/1.1'],
    });
    const timer = setTimeout(() => {
      tlsSocket.destroy();
      reject(new ProxyRequestError('timeout', `${label} TLS 握手超时（${timeoutMs}ms）`));
    }, timeoutMs);

    tlsSocket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(tlsSocket);
    });
    tlsSocket.once('error', (error: Error) => {
      clearTimeout(timer);
      tlsSocket.destroy();
      reject(new ProxyRequestError('target', `${label} TLS 握手失败：${error.message}`));
    });
  });
}

/**
 * Bytes that a handshake reader already pulled off the socket but that belong
 * to the next protocol step. They are kept per socket instead of being pushed
 * back with `socket.unshift()`, because a push back while the socket is in
 * flowing mode is emitted immediately and would be lost.
 */
const pendingReads = new WeakMap<Socket, Buffer>();

function takePending(socket: Socket): Buffer {
  const buffered = pendingReads.get(socket);
  pendingReads.delete(socket);
  return buffered ?? Buffer.alloc(0);
}

function stashPending(socket: Socket, buffer: Buffer): void {
  if (buffer.length > 0) pendingReads.set(socket, buffer);
}

/**
 * Gives buffered bytes back to the socket before a foreign consumer (the TLS
 * layer or the HTTP client) takes it over.
 */
function releasePending(socket: Socket): void {
  const buffered = pendingReads.get(socket);
  pendingReads.delete(socket);
  if (!buffered || buffered.length === 0) return;

  socket.pause();
  socket.unshift(buffered);
  // The new consumer attaches its listeners synchronously right after this
  // call, so the resume has to wait for the next turn of the loop.
  setImmediate(() => {
    if (!socket.destroyed) socket.resume();
  });
}

/**
 * Reads from `socket` until `consume()` reports how many bytes the caller
 * needs. Bytes that were read but not consumed stay buffered for the next
 * step, so a response that arrives in one packet can be parsed in pieces.
 */
function readFrom(
  socket: Socket,
  consume: (buffer: Buffer) => number,
  timeoutMs: number,
  label: string,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let buffered = takePending(socket);
    let settled = false;

    const finish = (settle: (rest: Buffer) => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      settle(buffered);
    };

    const complete = (): boolean => {
      const size = consume(buffered);
      if (size <= 0) return false;
      const head = buffered.subarray(0, size);
      const rest = buffered.subarray(size);
      finish(() => {
        stashPending(socket, rest);
        resolve(head);
      });
      return true;
    };

    const timer = setTimeout(() => {
      finish(() => {
        socket.destroy();
        reject(new ProxyRequestError('timeout', `${label} 超时（${timeoutMs}ms）`));
      });
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      if (complete()) return;
      if (buffered.length <= MAX_HANDSHAKE_BYTES) return;
      finish(() => {
        socket.destroy();
        reject(new ProxyRequestError('proxy', `${label}返回了异常响应（超过 16KB 仍未结束）`));
      });
    };

    const onError = (error: Error): void => {
      finish(() => reject(new ProxyRequestError('proxy', `${label} 失败：${error.message}`)));
    };
    const onClose = (): void => {
      finish(() => reject(new ProxyRequestError('proxy', `${label} 失败：连接被关闭`)));
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);

    // Data may already be buffered (e.g. a reply split across two reads).
    complete();
  });
}

function readExact(
  socket: Socket,
  size: number,
  timeoutMs: number,
  label: string,
): Promise<Buffer> {
  return readFrom(socket, (buffer) => (buffer.length >= size ? size : 0), timeoutMs, label);
}

function indexOfHeaderEnd(buffer: Buffer): number {
  const index = buffer.indexOf('\r\n\r\n');
  return index === -1 ? 0 : index + 4;
}

function basicAuth(proxy: ParsedProxyUrl): string {
  const user = `${proxy.username}:${proxy.password}`;
  return `Basic ${Buffer.from(user, 'utf8').toString('base64')}`;
}

async function openHttpTunnel(
  proxy: ParsedProxyUrl,
  target: { host: string; port: number },
  timeoutMs: number,
): Promise<Socket> {
  let socket = await dialTcp(
    proxy.host,
    proxy.port,
    timeoutMs,
    'proxy',
    `连接代理 ${proxy.origin}`,
  );
  if (proxy.scheme === 'https') {
    socket = await wrapTls(socket, proxy.host, timeoutMs, `代理 ${proxy.origin}`);
  }

  const lines = [
    `CONNECT ${target.host}:${target.port} HTTP/1.1`,
    `Host: ${target.host}:${target.port}`,
    'Proxy-Connection: Keep-Alive',
  ];
  if (proxy.username.length > 0 || proxy.password.length > 0) {
    lines.push(`Proxy-Authorization: ${basicAuth(proxy)}`);
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);

  const head = await readFrom(socket, indexOfHeaderEnd, timeoutMs, '代理 CONNECT 握手');
  const statusLine = head.toString('latin1').split('\r\n')[0] ?? '';
  const status = Number.parseInt(statusLine.split(/\s+/)[1] ?? '', 10);
  if (status !== 200) {
    socket.destroy();
    const hint =
      status === 407
        ? '（该代理需要认证，请在地址中填写 user:pass@host:port）'
        : status === 403
          ? '（代理拒绝了目标主机）'
          : '';
    throw new ProxyRequestError('proxy', `代理拒绝建立隧道：${statusLine || '无响应'}${hint}`);
  }
  return socket;
}

async function socksAddress(
  host: string,
  remoteDns: boolean,
): Promise<{ atyp: number; address: Buffer }> {
  if (!remoteDns) {
    const resolved = await lookup(host);
    if (resolved.family === 6) {
      return { atyp: 0x04, address: ipv6Bytes(resolved.address) };
    }
    return { atyp: 0x01, address: ipv4Bytes(resolved.address) };
  }
  const encoded = Buffer.from(host, 'utf8');
  if (encoded.length > 255) {
    throw new ProxyRequestError('invalid', `目标主机名过长：${host}`);
  }
  return { atyp: 0x03, address: Buffer.concat([Buffer.from([encoded.length]), encoded]) };
}

function ipv4Bytes(address: string): Buffer {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  return Buffer.from(parts);
}

function ipv6Bytes(address: string): Buffer {
  const [head, tail = ''] = address.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [
    ...headGroups,
    ...Array.from({ length: Math.max(missing, 0) }, () => '0'),
    ...tailGroups,
  ];
  const buffer = Buffer.alloc(16);
  groups.slice(0, 8).forEach((group, index) => {
    buffer.writeUInt16BE(Number.parseInt(group || '0', 16), index * 2);
  });
  return buffer;
}

async function openSocksTunnel(
  proxy: ParsedProxyUrl,
  target: { host: string; port: number },
  timeoutMs: number,
): Promise<Socket> {
  const socket = await dialTcp(
    proxy.host,
    proxy.port,
    timeoutMs,
    'proxy',
    `连接 SOCKS5 代理 ${proxy.origin}`,
  );

  const useAuth = proxy.username.length > 0 || proxy.password.length > 0;
  socket.write(Buffer.from(useAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));

  const greeting = await readExact(socket, 2, timeoutMs, 'SOCKS5 握手');
  if (greeting[0] !== 0x05) {
    socket.destroy();
    throw new ProxyRequestError('proxy', '该端口不是 SOCKS5 代理（版本号不匹配）');
  }

  const method = greeting[1] as number;
  if (method === 0x02) {
    const user = Buffer.from(proxy.username, 'utf8');
    const pass = Buffer.from(proxy.password, 'utf8');
    if (user.length > 255 || pass.length > 255) {
      socket.destroy();
      throw new ProxyRequestError('invalid', 'SOCKS5 用户名或密码过长（最多 255 字节）');
    }
    socket.write(
      Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]),
    );
    const auth = await readExact(socket, 2, timeoutMs, 'SOCKS5 认证');
    if (auth[1] !== 0x00) {
      socket.destroy();
      throw new ProxyRequestError('proxy', 'SOCKS5 代理认证失败（用户名或密码不正确）');
    }
  } else if (method === 0xff) {
    socket.destroy();
    throw new ProxyRequestError(
      'proxy',
      proxy.username || proxy.password
        ? 'SOCKS5 代理拒绝了提供的认证方式'
        : 'SOCKS5 代理要求认证，请在代理地址中填写 user:pass@host:port',
    );
  } else if (method !== 0x00) {
    socket.destroy();
    throw new ProxyRequestError(
      'proxy',
      `SOCKS5 代理返回了不支持的认证方式：0x${method.toString(16)}`,
    );
  }

  let address: { atyp: number; address: Buffer };
  try {
    address = await socksAddress(target.host, proxy.remoteDns);
  } catch (error) {
    socket.destroy();
    if (error instanceof ProxyRequestError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProxyRequestError('target', `无法解析目标主机 ${target.host}：${detail}`);
  }

  socket.write(
    Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, address.atyp]),
      address.address,
      Buffer.from([target.port >> 8, target.port & 0xff]),
    ]),
  );

  const replyHead = await readExact(socket, 4, timeoutMs, 'SOCKS5 应答');
  const replyCode = replyHead[1] as number;
  if (replyCode !== 0x00) {
    socket.destroy();
    throw new ProxyRequestError(
      'proxy',
      `${SOCKS_REPLY_MESSAGES[replyCode] ?? `SOCKS5 代理返回错误码 ${replyCode}`}（${target.host}:${target.port}）`,
    );
  }

  const atyp = replyHead[3] as number;
  const tailSize =
    atyp === 0x01
      ? 4
      : atyp === 0x04
        ? 16
        : atyp === 0x03
          ? (await readExact(socket, 1, timeoutMs, 'SOCKS5 应答'))[0]!
          : 0;
  if (tailSize > 0) await readExact(socket, tailSize + 2, timeoutMs, 'SOCKS5 应答');
  return socket;
}

async function openTunnel(
  proxy: ParsedProxyUrl,
  target: { host: string; port: number },
  timeoutMs: number,
): Promise<Socket> {
  if (proxy.scheme === 'socks5' || proxy.scheme === 'socks5h') {
    return await openSocksTunnel(proxy, target, timeoutMs);
  }
  return await openHttpTunnel(proxy, target, timeoutMs);
}

type SocketFactory = () => Promise<Duplex>;

/** Hands an already established (and possibly TLS wrapped) socket to http. */
class TunnelAgent extends http.Agent {
  constructor(private readonly factory: SocketFactory) {
    super({ keepAlive: false, maxSockets: 1 });
  }

  override createConnection(
    _options: http.AgentOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): undefined {
    this.factory().then(
      (stream) => callback?.(null, stream),
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        // The agent only ever looks at the first argument when it is set.
        callback?.(failure, undefined as unknown as Duplex);
      },
    );
    return undefined;
  }
}

function normalizeHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

function decodeBody(raw: Buffer, encoding: string | undefined): string {
  const value = (encoding ?? '').toLowerCase();
  try {
    if (value.includes('gzip')) return gunzipSync(raw).toString('utf8');
    if (value.includes('br')) return brotliDecompressSync(raw).toString('utf8');
    if (value.includes('deflate')) return inflateSync(raw).toString('utf8');
  } catch {
    // Fall through to the raw payload when decompression fails.
  }
  return raw.toString('utf8');
}

async function sendOnce(
  input: Required<Pick<ProxyHttpInput, 'url'>> & {
    method: string;
    headers: Record<string, string>;
    body: string | Buffer | null;
    timeoutMs: number;
    proxyUrl: string;
  },
): Promise<ProxyHttpResponse> {
  const target = new URL(input.url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new ProxyRequestError('invalid', `不支持的请求协议：${target.protocol}`);
  }

  let proxy: ParsedProxyUrl;
  try {
    proxy = parseProxyUrl(input.proxyUrl);
  } catch (error) {
    throw new ProxyRequestError('invalid', error instanceof Error ? error.message : String(error));
  }

  const tlsTarget = target.protocol === 'https:';
  const targetHost = target.hostname.replace(/^\[|\]$/g, '');
  const targetPort = target.port ? Number.parseInt(target.port, 10) : tlsTarget ? 443 : 80;
  const plainHttpProxy = proxy.scheme === 'http' || proxy.scheme === 'https';
  // A plain HTTP target can be requested in absolute form, no tunnel needed.
  const absoluteForm = !tlsTarget && plainHttpProxy;

  const agent = new TunnelAgent(async () => {
    if (absoluteForm) {
      let socket = await dialTcp(
        proxy.host,
        proxy.port,
        input.timeoutMs,
        'proxy',
        `连接代理 ${proxy.origin}`,
      );
      if (proxy.scheme === 'https') {
        socket = await wrapTls(socket, proxy.host, input.timeoutMs, `代理 ${proxy.origin}`);
      }
      return socket;
    }
    const tunnel = await openTunnel(proxy, { host: targetHost, port: targetPort }, input.timeoutMs);
    if (!tlsTarget) {
      releasePending(tunnel);
      return tunnel;
    }
    releasePending(tunnel);
    return await wrapTls(tunnel, targetHost, input.timeoutMs, `目标 ${targetHost}`);
  });

  const headers: Record<string, string> = { ...input.headers };
  if (absoluteForm && (proxy.username.length > 0 || proxy.password.length > 0)) {
    headers['Proxy-Authorization'] = basicAuth(proxy);
  }
  if (input.body !== null && headers['Content-Length'] === undefined) {
    headers['Content-Length'] = String(Buffer.byteLength(input.body));
  }

  const path = absoluteForm ? target.toString() : `${target.pathname}${target.search}`;

  try {
    return await new Promise<ProxyHttpResponse>((resolve, reject) => {
      const request = http.request(
        {
          host: targetHost,
          port: targetPort,
          path,
          method: input.method,
          headers,
          agent,
        },
        (response) => {
          // 407 is never a target response: it always means the proxy wants
          // credentials, which is worth surfacing as a proxy error.
          if (response.statusCode === 407) {
            clearTimeout(timer);
            response.resume();
            reject(
              new ProxyRequestError(
                'proxy',
                '代理需要认证（HTTP 407）：请在代理地址中填写 user:pass@host:port',
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('error', (error: Error) => {
            clearTimeout(timer);
            reject(new ProxyRequestError('target', `读取响应失败：${error.message}`));
          });
          response.on('end', () => {
            clearTimeout(timer);
            resolve({
              status: response.statusCode ?? 0,
              headers: normalizeHeaders(response.headers),
              body: decodeBody(Buffer.concat(chunks), response.headers['content-encoding']),
              url: input.url,
            });
          });
        },
      );

      const timer = setTimeout(() => {
        request.destroy(new ProxyRequestError('timeout', `请求超时（${input.timeoutMs}ms）`));
      }, input.timeoutMs);

      request.on('error', (error: Error) => {
        clearTimeout(timer);
        request.destroy();
        reject(
          error instanceof ProxyRequestError
            ? error
            : new ProxyRequestError('target', `请求 ${targetHost} 失败：${error.message}`),
        );
      });

      if (input.body === null) request.end();
      else request.end(input.body);
    });
  } finally {
    agent.destroy();
  }
}

function isRedirect(status: number): boolean {
  return REDIRECT_STATUS.has(status);
}

/** Performs an HTTP request through `proxyUrl`, following up to 4 redirects. */
export async function requestViaProxy(input: ProxyHttpInput): Promise<ProxyHttpResponse> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxRedirects = input.maxRedirects ?? MAX_REDIRECTS;

  let url = input.url;
  let method = (input.method ?? 'GET').toUpperCase();
  let body = input.body ?? null;
  const headers: Record<string, string> = { ...(input.headers ?? {}) };

  for (let hop = 0; ; hop += 1) {
    const response = await sendOnce({
      url,
      method,
      headers,
      body,
      timeoutMs,
      proxyUrl: input.proxyUrl,
    });

    const location = response.headers.location;
    if (!isRedirect(response.status) || !location || hop >= maxRedirects) {
      return { ...response, url };
    }

    const nextUrl = new URL(location, url);
    if (nextUrl.host !== new URL(url).host) {
      // Never forward credentials to another host.
      delete headers.Authorization;
      delete headers.authorization;
      delete headers['Proxy-Authorization'];
    }
    if (response.status === 303 || method === 'GET' || method === 'HEAD') {
      method = 'GET';
      body = null;
      delete headers['Content-Type'];
      delete headers['content-type'];
      delete headers['Content-Length'];
      delete headers['content-length'];
    }
    url = nextUrl.toString();
  }
}
