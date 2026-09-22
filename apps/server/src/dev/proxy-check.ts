/**
 * Self check for the proxy client used by AutoGit.
 *
 * It starts throwaway servers on 127.0.0.1 — an origin, an HTTP proxy
 * (absolute form + CONNECT, optional Basic auth) and a SOCKS5 proxy (optional
 * user/password) — and drives `requestViaProxy` through every combination,
 * including the failure paths users see when a proxy is misconfigured.
 *
 * Usage:
 *   pnpm --filter @autogit/server proxy:check            # offline, local only
 *   pnpm --filter @autogit/server proxy:check -- --online # also tunnel a real HTTPS target
 */

import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from 'node:http';
import {
  type AddressInfo,
  createServer as createTcpServer,
  type Server as TcpServer,
  connect as tcpConnect,
} from 'node:net';
import { gzipSync } from 'node:zlib';

import { ProxyRequestError, requestViaProxy } from '../util/proxy-http.js';

interface Running {
  port: number;
  log: string[];
  close: () => Promise<void>;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
const online = process.argv.includes('--online');

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

async function expectOk(name: string, run: () => Promise<string>): Promise<void> {
  try {
    const detail = await run();
    record(name, true, detail);
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

async function expectFailure(
  name: string,
  run: () => Promise<unknown>,
  expect: RegExp,
): Promise<void> {
  try {
    await run();
    record(name, false, '期望失败，但请求成功了');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(name, expect.test(message), message);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function listen(server: Server | TcpServer, label: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      process.stdout.write(`  · ${label} 监听 127.0.0.1:${address.port}\n`);
      resolve(address.port);
    });
  });
}

function closeServer(server: Server | TcpServer): Promise<void> {
  return new Promise((resolve) => {
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** Plain HTTP origin: echoes the request, can redirect and gzip. */
async function startOrigin(): Promise<Running> {
  const log: string[] = [];
  const server = createHttpServer((request, response) => {
    const url = request.url ?? '/';
    log.push(`${request.method} ${url}`);

    if (url.startsWith('/redirect')) {
      response.writeHead(302, { Location: '/final' });
      response.end();
      return;
    }
    if (url.startsWith('/final')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, path: '/final' }));
      return;
    }
    if (url.startsWith('/gzip')) {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      });
      response.end(gzipSync(JSON.stringify({ ok: true, gzipped: true })));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, path: url }));
  });

  return { port: await listen(server, 'origin'), log, close: () => closeServer(server) };
}

interface ProxyOptions {
  auth?: { user: string; pass: string };
}

function proxyAuthorized(request: IncomingMessage, options: ProxyOptions): boolean {
  if (!options.auth) return true;
  const header = request.headers['proxy-authorization'];
  if (typeof header !== 'string') return false;
  const [, encoded] = header.split(/\s+/, 2);
  const expected = Buffer.from(`${options.auth.user}:${options.auth.pass}`, 'utf8').toString(
    'base64',
  );
  return encoded === expected;
}

/** HTTP proxy: absolute form forwarding plus `CONNECT` tunnelling. */
async function startHttpProxy(options: ProxyOptions = {}): Promise<Running> {
  const log: string[] = [];
  const server = createHttpServer((request, response) => {
    log.push(`${request.method ?? 'GET'} ${request.url ?? ''}`);
    if (!proxyAuthorized(request, options)) {
      response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="autogit-check"' });
      response.end('proxy authentication required');
      return;
    }

    let target: URL;
    try {
      target = new URL(request.url ?? '');
    } catch {
      response.writeHead(400);
      response.end('absolute form expected');
      return;
    }

    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers: { ...request.headers, host: target.host },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', () => {
      response.writeHead(502);
      response.end('upstream failed');
    });
    request.pipe(upstream);
  });

  server.on('connect', (request, clientSocket, head) => {
    log.push(`CONNECT ${request.url ?? ''}`);
    if (!proxyAuthorized(request, options)) {
      clientSocket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="autogit-check"\r\n\r\n',
      );
      clientSocket.destroy();
      return;
    }

    const [host, port] = (request.url ?? '').split(':');
    const upstream = tcpConnect({ host, port: Number(port) }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  return { port: await listen(server, 'http proxy'), log, close: () => closeServer(server) };
}

/** SOCKS5 proxy with RFC 1929 user/password support. */
async function startSocks5Proxy(options: ProxyOptions = {}): Promise<Running> {
  const log: string[] = [];

  const server = createTcpServer((socket) => {
    let stage: 'greeting' | 'auth' | 'request' | 'relay' = 'greeting';
    let buffered: Buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      pump();
    };

    const pump = (): void => {
      for (;;) {
        if (stage === 'greeting') {
          if (buffered.length < 2) return;
          const count = buffered[1] as number;
          if (buffered.length < 2 + count) return;
          const methods = [...buffered.subarray(2, 2 + count)];
          buffered = buffered.subarray(2 + count);
          const method = options.auth ? (methods.includes(0x02) ? 0x02 : 0xff) : 0x00;
          socket.write(Buffer.from([0x05, method]));
          if (method === 0xff) {
            socket.destroy();
            return;
          }
          stage = method === 0x02 ? 'auth' : 'request';
          continue;
        }

        if (stage === 'auth') {
          if (buffered.length < 2) return;
          const userLength = buffered[1] as number;
          if (buffered.length < 3 + userLength) return;
          const passLength = buffered[2 + userLength] as number;
          if (buffered.length < 3 + userLength + passLength) return;
          const user = buffered.subarray(2, 2 + userLength).toString('utf8');
          const pass = buffered
            .subarray(3 + userLength, 3 + userLength + passLength)
            .toString('utf8');
          buffered = buffered.subarray(3 + userLength + passLength);
          const ok = user === options.auth?.user && pass === options.auth?.pass;
          socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          if (!ok) {
            socket.destroy();
            return;
          }
          stage = 'request';
          continue;
        }

        if (stage === 'request') {
          if (buffered.length < 4) return;
          const atyp = buffered[3] as number;
          let host: string;
          let offset: number;
          if (atyp === 0x01) {
            if (buffered.length < 10) return;
            host = [...buffered.subarray(4, 8)].join('.');
            offset = 8;
          } else if (atyp === 0x03) {
            if (buffered.length < 5) return;
            const length = buffered[4] as number;
            if (buffered.length < 5 + length + 2) return;
            host = buffered.subarray(5, 5 + length).toString('utf8');
            offset = 5 + length;
          } else {
            socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.destroy();
            return;
          }
          const port = buffered.readUInt16BE(offset);
          buffered = buffered.subarray(offset + 2);
          log.push(`${host}:${port}`);

          const upstream = tcpConnect({ host, port }, () => {
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            stage = 'relay';
            socket.removeListener('data', onData);
            if (buffered.length > 0) upstream.write(buffered);
            socket.pipe(upstream);
            upstream.pipe(socket);
          });
          upstream.on('error', () => {
            socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.destroy();
          });
          socket.on('error', () => upstream.destroy());
          return;
        }

        return;
      }
    };

    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
  });

  return { port: await listen(server, 'socks5 proxy'), log, close: () => closeServer(server) };
}

async function main(): Promise<void> {
  process.stdout.write('AutoGit 代理链路自检\n');
  const origin = await startOrigin();
  const plain = await startHttpProxy();
  const authenticated = await startHttpProxy({ auth: { user: 'user', pass: 'pass' } });
  const socks = await startSocks5Proxy();
  const socksAuth = await startSocks5Proxy({ auth: { user: 'user', pass: 'pass' } });

  const originUrl = `http://127.0.0.1:${origin.port}/hello`;
  const httpProxyUrl = `http://127.0.0.1:${plain.port}`;
  const authProxyUrl = `http://user:pass@127.0.0.1:${authenticated.port}`;
  const socksUrl = `socks5://127.0.0.1:${socks.port}`;
  const socksAuthUrl = `socks5://user:pass@127.0.0.1:${socksAuth.port}`;

  process.stdout.write('\n本地链路：\n');

  await expectOk('HTTP 代理 · 绝对形式转发', async () => {
    const response = await requestViaProxy({ url: originUrl, proxyUrl: httpProxyUrl });
    assert(response.status === 200, `状态码 ${response.status}`);
    assert(
      plain.log.some((line) => line.startsWith('GET http://')),
      '代理没有收到绝对形式请求',
    );
    return 'HTTP 200，绝对形式正确';
  });

  await expectOk('HTTP 代理 · Basic 认证', async () => {
    const response = await requestViaProxy({ url: originUrl, proxyUrl: authProxyUrl });
    assert(response.status === 200, `状态码 ${response.status}`);
    return 'HTTP 200';
  });

  await expectFailure(
    'HTTP 代理 · 缺认证时给出可读错误',
    () =>
      requestViaProxy({
        url: originUrl,
        proxyUrl: `http://127.0.0.1:${authenticated.port}`,
      }),
    /407/,
  );

  await expectOk('SOCKS5 · IPv4 隧道', async () => {
    const response = await requestViaProxy({ url: originUrl, proxyUrl: socksUrl });
    assert(response.status === 200, `状态码 ${response.status}`);
    assert(
      socks.log.some((line) => line.includes('127.0.0.1')),
      'SOCKS5 代理没有收到目标',
    );
    return 'HTTP 200';
  });

  await expectOk('SOCKS5 · 用户名/密码', async () => {
    const response = await requestViaProxy({ url: originUrl, proxyUrl: socksAuthUrl });
    assert(response.status === 200, `状态码 ${response.status}`);
    return 'HTTP 200';
  });

  await expectFailure(
    'SOCKS5 · 密码错误时给出可读错误',
    () =>
      requestViaProxy({
        url: originUrl,
        proxyUrl: `socks5://user:wrong@127.0.0.1:${socksAuth.port}`,
      }),
    /认证失败/,
  );

  await expectOk('SOCKS5h · 远程 DNS', async () => {
    const response = await requestViaProxy({
      url: `http://localhost:${origin.port}/hello`,
      proxyUrl: `socks5h://127.0.0.1:${socks.port}`,
    });
    assert(response.status === 200, `状态码 ${response.status}`);
    assert(
      socks.log.some((line) => line.startsWith('localhost:')),
      '未使用远程主机名解析',
    );
    return 'HTTP 200，主机名交给代理解析';
  });

  await expectOk('重定向跟随', async () => {
    const response = await requestViaProxy({
      url: `http://127.0.0.1:${origin.port}/redirect`,
      proxyUrl: httpProxyUrl,
    });
    assert(response.status === 200, `状态码 ${response.status}`);
    assert(response.body.includes('/final'), '未跟随到最终地址');
    return '302 → 200';
  });

  await expectOk('gzip 响应解码', async () => {
    const response = await requestViaProxy({
      url: `http://127.0.0.1:${origin.port}/gzip`,
      proxyUrl: socksUrl,
    });
    assert(response.body.includes('gzipped'), `响应体：${response.body.slice(0, 60)}`);
    return '解压成功';
  });

  await expectOk('HTTP 代理 · 目标不可达时给出可读结果', async () => {
    try {
      const response = await requestViaProxy({
        url: 'http://127.0.0.1:9/unreachable',
        proxyUrl: httpProxyUrl,
        timeoutMs: 4_000,
      });
      assert(response.status >= 400, `状态码 ${response.status}`);
      return `代理返回 HTTP ${response.status}`;
    } catch (error) {
      return `代理层报错：${error instanceof Error ? error.message : String(error)}`;
    }
  });

  await expectFailure(
    'SOCKS5 · 目标不可达时给出可读错误',
    () =>
      requestViaProxy({
        url: 'http://127.0.0.1:9/unreachable',
        proxyUrl: socksUrl,
        timeoutMs: 5_000,
      }),
    /SOCKS5/,
  );

  if (online) {
    process.stdout.write('\n线上链路（HTTPS + CONNECT 隧道）：\n');
    await expectOk('HTTP 代理 · CONNECT 隧道访问 GitHub API', async () => {
      const response = await requestViaProxy({
        url: 'https://api.github.com/',
        headers: { Accept: 'application/json', 'User-Agent': 'autogit/0.1' },
        proxyUrl: httpProxyUrl,
        timeoutMs: 15_000,
      });
      assert(response.status === 200, `状态码 ${response.status}`);
      assert(
        plain.log.some((line) => line.startsWith('CONNECT api.github.com:443')),
        '未走 CONNECT',
      );
      return 'HTTP 200';
    });

    await expectOk('SOCKS5 · 隧道访问 GitHub API', async () => {
      const response = await requestViaProxy({
        url: 'https://api.github.com/',
        headers: { Accept: 'application/json', 'User-Agent': 'autogit/0.1' },
        proxyUrl: socksUrl,
        timeoutMs: 15_000,
      });
      assert(response.status === 200, `状态码 ${response.status}`);
      return 'HTTP 200';
    });
  } else {
    process.stdout.write('\n（略过线上 HTTPS 检查，加 -- --online 可启用）\n');
  }

  await Promise.all([
    origin.close(),
    plain.close(),
    authenticated.close(),
    socks.close(),
    socksAuth.close(),
  ]);

  const failed = checks.filter((check) => !check.ok);
  process.stdout.write(
    `\n结果：${checks.length - failed.length}/${checks.length} 项通过${
      failed.length > 0 ? '，存在失败项' : ' ✅'
    }\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  if (error instanceof ProxyRequestError) {
    process.stderr.write(`自检失败：${error.message}\n`);
  } else {
    process.stderr.write(`自检失败：${error instanceof Error ? error.stack : String(error)}\n`);
  }
  process.exitCode = 1;
});
