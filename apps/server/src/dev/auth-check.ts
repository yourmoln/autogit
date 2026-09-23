/**
 * End-to-end self check for the login gate.
 *
 * Runs the real HTTP stack (`buildServer`) against a throwaway
 * `AUTOGIT_HOME`, so it verifies the parts a unit test would miss: the guard
 * hook on every `/api` route, the session cookie, "保持登录" persistence, the
 * credential change flow and the logout path.
 *
 * Usage: pnpm --filter @autogit/server auth:check
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import net, { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AuthSessionPayload } from '@autogit/shared';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../app.js';
import { applyDefaultNodeEnv, isCompiledEntry, loadRuntimeConfig } from '../config.js';
import { migrate } from '../db/migrations.js';
import {
  AUTH_LOGIN_BACKOFF_MS,
  AUTH_LOGIN_FAILURE_LIMIT,
  AUTH_SESSION_COOKIE,
  hashPassword,
  hashSessionToken,
} from '../services/auth.js';
import { HttpError } from '../util/http.js';
import { isTrustedOrigin } from '../util/origin.js';
import { nowIso } from '../util/time.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expect(name: string, run: () => Promise<string>): Promise<void> {
  try {
    record(name, true, await run());
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

/** Close code the server sends when the session behind a socket is gone. */
const SESSION_GONE_CLOSE_CODE = 4401;
/** Close code the server sends to the browser that rotated its own credentials. */
const SESSION_ROTATED_CLOSE_CODE = 4402;

interface RealtimeCloseOutcome {
  closed: boolean;
  code: number | null;
}

interface RealtimeProbe {
  /** Text frames the server pushed, in arrival order. */
  frames: string[];
  waitForFrame(timeoutMs: number): Promise<boolean>;
  waitForClose(timeoutMs: number): Promise<RealtimeCloseOutcome>;
  destroy(): void;
}

type RealtimeUpgrade =
  | { upgraded: true; probe: RealtimeProbe }
  | { upgraded: false; statusCode: number };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** Puts an env var back the way it was (including "was not set at all"). */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function pollUntil<T>(read: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await delay(20);
  }
}

/**
 * Reads the few frames the realtime channel sends (text + close).
 *
 * The check needs a WebSocket client that can send a `Cookie` header, which the
 * browser API cannot, and `app.inject()` cannot upgrade at all — so the frames
 * are parsed by hand instead of pulling in another dependency.
 */
function createRealtimeProbe(socket: Socket, head: Buffer): RealtimeProbe {
  const frames: string[] = [];
  let buffered = Buffer.from(head);
  let closeCode: number | null = null;
  let closed = false;

  const consume = (): void => {
    while (buffered.length >= 2) {
      const opcode = buffered[0]! & 0x0f;
      const masked = (buffered[1]! & 0x80) !== 0;
      let length = buffered[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        length = Number(buffered.readBigUInt64BE(2));
        offset = 10;
      }
      if (masked) offset += 4;
      if (buffered.length < offset + length) return;

      const payload = buffered.subarray(offset, offset + length);
      buffered = buffered.subarray(offset + length);
      if (opcode === 0x1) frames.push(payload.toString('utf8'));
      if (opcode === 0x8) {
        closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : null;
        closed = true;
      }
    }
  };
  // The handshake response and the first messages usually arrive together.
  consume();

  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    consume();
  });
  socket.on('close', () => {
    closed = true;
  });
  socket.on('error', () => {
    closed = true;
  });

  return {
    frames,
    waitForFrame: async (timeoutMs) =>
      (await pollUntil(() => (frames.length > 0 ? true : null), timeoutMs)) === true,
    waitForClose: async (timeoutMs) => {
      await pollUntil(() => (closed ? true : null), timeoutMs);
      return { closed, code: closeCode };
    },
    destroy: () => socket.destroy(),
  };
}

/**
 * Performs a real upgrade over TCP; a rejected handshake resolves with its status.
 *
 * `node:http` is deliberately not used here: a rejected upgrade is written to the
 * socket and the socket is destroyed right after, and the HTTP client surfaces that
 * race as `ECONNRESET` instead of the status code the check wants to assert on.
 */
function upgradeRealtime(
  port: number,
  requestPath: string,
  cookie: string | null,
  origin?: string | null,
): Promise<RealtimeUpgrade> {
  return new Promise<RealtimeUpgrade>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = Buffer.alloc(0);
    let settled = false;

    socket.setTimeout(5_000, () => {
      socket.destroy();
      if (!settled) reject(new Error(`升级 ${requestPath} 超时`));
    });

    socket.on('error', (error) => {
      if (!settled) reject(error);
    });

    socket.on('connect', () => {
      const lines = [
        `GET ${requestPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      ];
      if (cookie) lines.push(`Cookie: ${cookie}`);
      // Browsers always send `Origin` on a WebSocket handshake; leaving it out
      // stands in for a non-browser client (`curl`, a probe, a script).
      if (origin) lines.push(`Origin: ${origin}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });

    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      if (settled) return;

      const headerEnd = received.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const statusLine = received.subarray(0, received.indexOf('\r\n')).toString('utf8');
      const statusCode = Number.parseInt(statusLine.split(' ')[1] ?? '', 10);
      const rest = received.subarray(headerEnd + 4);

      if (statusCode === 101) {
        settled = true;
        socket.off('data', onData);
        resolve({ upgraded: true, probe: createRealtimeProbe(socket, rest) });
        return;
      }

      settled = true;
      socket.destroy();
      resolve({ upgraded: false, statusCode });
    };

    socket.on('data', onData);
  });
}

function listeningPort(app: FastifyInstance): number {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('无法确定监听端口');
  return address.port;
}

/** Extracts the raw session token out of a `Set-Cookie` header. */
function cookieToken(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie.join('\n') : (setCookie ?? '');
  const match = new RegExp(`${AUTH_SESSION_COOKIE}=([^;\\s]+)`).exec(header);
  if (!match) throw new Error(`响应未下发 ${AUTH_SESSION_COOKIE} cookie`);
  return decodeURIComponent(match[1] as string);
}

function cookieHeader(token: string): string {
  return `${AUTH_SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

async function main(): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), 'autogit-auth-'));
  process.env.AUTOGIT_HOME = home;
  process.env.AUTOGIT_LOG_LEVEL = 'warn';

  const config = loadRuntimeConfig();
  assert(config.home === path.resolve(home), `数据目录未隔离：${config.home}`);
  assert(
    config.isDev,
    `auth:check 需要开发模式运行，当前 NODE_ENV=${process.env.NODE_ENV ?? '(未设置)'}`,
  );
  assert(
    config.devOrigins.includes('http://localhost:5173'),
    `开发模式没有放行 Vite 开发来源：${config.devOrigins.join('、') || '(空)'}`,
  );

  const { app, ctx } = await buildServer(config);
  await app.ready();
  const realtimeProbes: RealtimeProbe[] = [];
  process.stdout.write(`使用临时数据目录 ${config.home}\n\n登录门禁：\n`);

  try {
    await expect('未登录访问 /api/system/overview → 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/system/overview' });
      assert(response.statusCode === 401, `状态码 ${response.statusCode}`);
      return 'HTTP 401';
    });

    await expect('未登录访问实时通道 /api/realtime → 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/realtime' });
      assert(response.statusCode === 401, `状态码 ${response.statusCode}`);
      return 'HTTP 401';
    });

    await expect('OPTIONS 不再无条件放行（未登录 / 预检样式 → 401）', async () => {
      // The guard used to `return` for every OPTIONS request under `/api` before
      // it looked at the session, so the method was a standing hole that the first
      // OPTIONS route would have fallen through. AutoGit answers no preflight
      // (same-origin console, no CORS layer), so OPTIONS is guarded like any other
      // method: a preflight-shaped request without a session is still a 401.
      const anonymous = await app.inject({ method: 'OPTIONS', url: '/api/system/overview' });
      assert(anonymous.statusCode === 401, `未登录 OPTIONS → ${anonymous.statusCode}`);
      assert(
        anonymous.headers['access-control-allow-origin'] === undefined,
        '未登录 OPTIONS 返回了跨源头',
      );

      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/api/system/overview',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'content-type',
        },
      });
      assert(preflight.statusCode === 401, `预检样式 OPTIONS → ${preflight.statusCode}`);
      return 'HTTP 401';
    });

    await expect('未登录也能探活（GET /api/health → 200，只回运行状态）', async () => {
      // 探活接口是唯一为「没有会话的调用方」保留的业务接口：systemd、容器
      // healthcheck 与外部监控都拿不到 Cookie，变成 401 就等于升级后静默失败。
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      assert(response.statusCode === 200, `状态码 ${response.statusCode}`);
      const payload = response.json<Record<string, unknown>>();
      assert(payload.ok === true, `健康响应缺少 ok：${JSON.stringify(payload)}`);
      assert(typeof payload.uptimeSeconds === 'number', '健康响应缺少 uptimeSeconds');
      const keys = Object.keys(payload).sort().join(',');
      assert(keys === 'node,ok,uptimeSeconds,version', `健康响应暴露了额外字段：${keys}`);

      // 百分号编码命中的是同一条路由，因此同样放行；其它接口不受影响。
      const encoded = await app.inject({ method: 'GET', url: '/%61pi/health' });
      assert(encoded.statusCode === 200, `编码后的探活接口 → ${encoded.statusCode}`);
      return 'HTTP 200';
    });

    await expect('GET /api/auth/session 未登录时返回 authenticated=false', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/auth/session' });
      const payload = response.json<AuthSessionPayload>();
      assert(response.statusCode === 200, `状态码 ${response.statusCode}`);
      assert(payload.authenticated === false, '未登录却返回已登录');
      assert(payload.session === null && payload.credentials === null, '未登录却返回会话信息');
      return 'HTTP 200';
    });

    process.stdout.write('\n登录：\n');

    await expect('错误密码登录 → 401', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong-password' },
      });
      assert(response.statusCode === 401, `状态码 ${response.statusCode}`);
      return 'HTTP 401';
    });

    await expect('用户名不存在与密码错误不可区分（响应时间 + 文案）', async () => {
      // `login()` used to short circuit on a mismatching username, so an unknown
      // username answered in well under a millisecond while a wrong password
      // paid a ~25ms scrypt — a username oracle. Both paths now run exactly one
      // scrypt against the stored (or a decoy) hash.
      const attempt = (username: string): { ms: number; status: number; message: string } => {
        const started = performance.now();
        let status = 200;
        let message = '';
        try {
          ctx.auth.login({ username, password: 'wrong-password', remember: false });
        } catch (error) {
          status = error instanceof HttpError ? error.statusCode : 0;
          message = error instanceof Error ? error.message : String(error);
        }
        return { ms: performance.now() - started, status, message };
      };

      const unknown = attempt('no-such-user');
      const known = attempt('admin');
      assert(unknown.status === 401, `未知用户名返回 ${unknown.status}`);
      assert(known.status === 401, `错误密码返回 ${known.status}`);
      assert(
        unknown.message === known.message,
        `错误文案不同：${unknown.message} / ${known.message}`,
      );
      assert(unknown.ms >= 8, `未知用户名单次 ${unknown.ms.toFixed(1)}ms，疑似跳过了 scrypt`);
      assert(
        unknown.ms >= known.ms * 0.3,
        `未知用户名 ${unknown.ms.toFixed(1)}ms 明显快于已存在的用户名 ${known.ms.toFixed(1)}ms`,
      );
      return `未知 ${unknown.ms.toFixed(1)}ms / 已存在 ${known.ms.toFixed(1)}ms`;
    });

    await expect('百分号编码路径不能绕过登录门禁（/%61pi/... → 401）', async () => {
      // The router matches percent-decoded paths while `request.url` keeps the raw
      // bytes; the guard used to compare the raw string and let every one of these
      // through, including the write endpoints and the realtime upgrade.
      const attempts: Array<{ method: 'GET' | 'POST' | 'OPTIONS'; url: string }> = [
        { method: 'GET', url: '/%61pi/system/overview' },
        { method: 'GET', url: '/%61pi/system/activity' },
        { method: 'GET', url: '/%61pi/settings' },
        { method: 'GET', url: '/api/%73ystem/overview' },
        { method: 'POST', url: '/%61pi/orchestrator/restart' },
        { method: 'POST', url: '/%61pi/orchestrator/tick' },
        { method: 'GET', url: '/%61pi/realtime' },
        { method: 'OPTIONS', url: '/%61pi/system/overview' },
      ];
      for (const attempt of attempts) {
        const response = await app.inject({
          method: attempt.method,
          url: attempt.url,
          // The old bypass was also readable from any website (reflected CORS).
          headers: { origin: 'https://evil.example' },
        });
        assert(
          response.statusCode === 401,
          `${attempt.method} ${attempt.url} → ${response.statusCode}`,
        );
        assert(
          response.headers['access-control-allow-origin'] === undefined,
          `${attempt.method} ${attempt.url} 仍然返回跨源头`,
        );
      }
      return `${attempts.length} 个编码路径全部 401`;
    });

    await expect('编码后的公开路由仍然放行（/%61pi/auth/session → 200）', async () => {
      const response = await app.inject({ method: 'GET', url: '/%61pi/auth/session' });
      assert(response.statusCode === 200, `状态码 ${response.statusCode}`);
      const payload = response.json<AuthSessionPayload>();
      assert(payload.authenticated === false, '未携带 Cookie 却返回已登录');
      return 'HTTP 200';
    });

    let sessionToken = '';
    await expect('默认账号 admin / admin 可登录', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'admin' },
      });
      assert(response.statusCode === 200, `状态码 ${response.statusCode}`);
      sessionToken = cookieToken(response.headers['set-cookie']);
      const payload = response.json<{ credentials: { defaultCredentials: boolean } | null }>();
      assert(payload.credentials?.defaultCredentials === true, '未提示仍在使用默认密码');
      return `HTTP 200，会话 ${sessionToken.slice(0, 8)}…`;
    });

    await expect('登录后 /api/system/overview 可访问', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/system/overview',
        headers: { cookie: cookieHeader(sessionToken) },
      });
      assert(response.statusCode === 200, `状态码 ${response.statusCode}`);
      return 'HTTP 200';
    });

    await expect('未勾选保持登录时不下发 Max-Age（会话 cookie）', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'admin', remember: false },
      });
      const header = String(response.headers['set-cookie'] ?? '');
      assert(!/max-age/i.test(header), '未勾选保持登录却下发了 Max-Age');
      return '无 Max-Age';
    });

    await expect('勾选保持登录时下发 30 天 Max-Age 且自动续期', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'admin', remember: true },
      });
      const header = String(response.headers['set-cookie'] ?? '');
      const match = /max-age=(\d+)/i.exec(header);
      assert(match, '缺少 Max-Age');
      const days = Number(match[1]) / 86_400;
      assert(days > 29 && days <= 30, `Max-Age 异常：${match[1]} 秒`);

      const payload = response.json<AuthSessionPayload>();
      assert(payload.session?.persistent === true, '会话未标记为保持登录');
      return `Max-Age ${match[1]} 秒`;
    });

    await expect('会话摘要不做同步 scrypt（GET /api/auth/session 的快路径）', async () => {
      const summary = ctx.auth.credentialsSummary();
      assert(summary.defaultCredentials === true, '默认账号未被识别为默认凭据');

      const rounds = 5;
      const started = performance.now();
      for (let index = 0; index < rounds; index += 1) ctx.auth.credentialsSummary();
      const perCall = (performance.now() - started) / rounds;
      // Verifying the factory password takes ~25ms of blocking scrypt per call.
      assert(perCall < 10, `单次 ${perCall.toFixed(1)}ms，疑似仍在做密码学校验`);
      return `单次 ${perCall.toFixed(2)}ms`;
    });

    await expect('跨源请求不再反射 Origin（无 Access-Control-* 头）', async () => {
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'admin' },
      });
      const token = cookieToken(login.headers['set-cookie']);
      const response = await app.inject({
        method: 'GET',
        url: '/api/system/overview',
        headers: { cookie: cookieHeader(token), origin: 'https://evil.example' },
      });
      assert(response.statusCode === 200, `状态码 ${response.statusCode}`);
      assert(
        response.headers['access-control-allow-origin'] === undefined,
        `仍然反射 Origin：${String(response.headers['access-control-allow-origin'])}`,
      );
      assert(
        response.headers['access-control-allow-credentials'] === undefined,
        '仍然允许跨源请求携带凭证',
      );
      return '无 CORS 响应头';
    });

    await expect('跨站 Origin 的状态变更请求被拒绝（403，未登录仍 401）', async () => {
      // Writes used to stand on the session cookie alone, and `SameSite=Lax` only
      // keeps *cross-site* pages from attaching it: a page on the same site but
      // another port (127.0.0.1:9999 here, the Vite dev server keeps 5173) sends
      // the cookie along, and a request without a body is a simple request the
      // browser performs without a preflight. So `Origin` has to be checked
      // server-side; the session check still runs first, so an anonymous caller
      // cannot use the status code to learn whether an origin is trusted.
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'admin' },
      });
      const token = cookieToken(login.headers['set-cookie']);

      const writes = [
        '/api/orchestrator/tick',
        '/api/orchestrator/restart',
        '/api/codex/invalidate',
      ];
      const origins = ['https://evil.example', 'http://127.0.0.1:9999'];
      for (const url of writes) {
        for (const origin of origins) {
          const response = await app.inject({
            method: 'POST',
            url,
            headers: { cookie: cookieHeader(token), origin },
          });
          assert(response.statusCode === 403, `POST ${url}（${origin}）→ ${response.statusCode}`);
        }
      }

      // Public writes are inside the gate as well: `POST /api/auth/login` has no
      // session to check, and a cross-site page that could trigger it would log
      // this browser into an account the attacker controls.
      const publicWrite = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: 'https://evil.example' },
        payload: { username: 'admin', password: 'admin' },
      });
      assert(
        publicWrite.statusCode === 403,
        `跨站 POST /api/auth/login → ${publicWrite.statusCode}`,
      );

      const anonymous = await app.inject({
        method: 'POST',
        url: '/api/orchestrator/tick',
        headers: { origin: 'https://evil.example' },
      });
      assert(anonymous.statusCode === 401, `未登录的跨站写请求 → ${anonymous.statusCode}`);
      return `HTTP 403 ×${writes.length * origins.length}（公开写请求 403、未登录 401）`;
    });

    await expect('同源、Vite 开发来源与无 Origin 的写请求仍然放行', async () => {
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'admin' },
      });
      const cookie = cookieHeader(cookieToken(login.headers['set-cookie']));

      // 浏览器里最普通的写法：`Origin` 与请求到达的 `Host` 一致。
      const sameOrigin = await app.inject({
        method: 'POST',
        url: '/api/orchestrator/restart',
        headers: { cookie, host: '127.0.0.1:4711', origin: 'http://127.0.0.1:4711' },
      });
      assert(sameOrigin.statusCode === 200, `同源写请求 → ${sameOrigin.statusCode}`);

      // 开发模式：Vite 代理用 changeOrigin 把 `Host` 改写成后端地址，控制台自己
      // 的来源必须放行，否则本地开发时每个按钮都会 403。
      const devOrigin = await app.inject({
        method: 'POST',
        url: '/api/orchestrator/restart',
        headers: { cookie, origin: 'http://localhost:5173' },
      });
      assert(devOrigin.statusCode === 200, `Vite 开发来源 → ${devOrigin.statusCode}`);

      // 非浏览器调用方（curl、探针、脚本）不发 `Origin`，继续可用。
      const noOrigin = await app.inject({
        method: 'POST',
        url: '/api/orchestrator/tick',
        headers: { cookie },
      });
      assert(noOrigin.statusCode === 200, `无 Origin 的写请求 → ${noOrigin.statusCode}`);
      return 'HTTP 200 ×3';
    });

    await expect('保持登录续期时同步续期浏览器 Cookie', async () => {
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'admin', remember: true },
      });
      const token = cookieToken(login.headers['set-cookie']);
      const tokenHash = hashSessionToken(token);
      const stored = ctx.store.getAuthSession(tokenHash);
      assert(stored, '登录后没有会话记录');
      // "打开页面" a bit later: the sliding renewal is throttled to 5 minutes.
      // The stored `expires_at` is aged together with `last_seen_at`, so the
      // assertions below compare two different windows. "Renewal landed in the
      // same millisecond as the login" used to produce the identical
      // `now + 30 天` string and made the old string comparison flaky.
      const agedExpiresAt = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
      ctx.store.touchAuthSession(
        tokenHash,
        new Date(Date.now() - 10 * 60_000).toISOString(),
        agedExpiresAt,
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/system/overview',
        headers: { cookie: cookieHeader(token) },
      });
      assert(response.statusCode === 200, `状态码 ${response.statusCode}`);
      const header = String(response.headers['set-cookie'] ?? '');
      const match = /max-age=(\d+)/i.exec(header);
      assert(match, `续期后没有下发新的 Cookie：${header || '(空)'}`);
      const cookieMaxAgeMs = Number(match[1]) * 1000;
      assert(
        cookieMaxAgeMs > 29 * 86_400_000 && cookieMaxAgeMs <= 30 * 86_400_000,
        `续期后的 Max-Age 异常：${match[1]} 秒`,
      );

      const renewed = ctx.store.getAuthSession(tokenHash);
      assert(renewed, '续期后会话记录消失了');
      // The stored window has to move forward by the 10 days it was aged by,
      // and it has to agree with the `Max-Age` the browser just received.
      const forwardMs = Date.parse(renewed.expiresAt) - Date.parse(agedExpiresAt);
      assert(
        forwardMs > 9 * 86_400_000 && forwardMs < 10 * 86_400_000 + 60_000,
        `库里的过期时间没有按 30 天窗口顺延：前移 ${(forwardMs / 86_400_000).toFixed(2)} 天`,
      );
      const skewMs = Math.abs(Date.parse(renewed.expiresAt) - (Date.now() + cookieMaxAgeMs));
      assert(skewMs < 5_000, `库内 expires_at 与 Cookie Max-Age 相差 ${Math.round(skewMs)}ms`);
      return `新 Cookie Max-Age ${match[1]} 秒，库内顺延 ${(forwardMs / 86_400_000).toFixed(1)} 天`;
    });

    await expect('非保持登录的会话不滚动续期（上限 12 小时）', async () => {
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'admin', remember: false },
      });
      const token = cookieToken(login.headers['set-cookie']);
      const tokenHash = hashSessionToken(token);
      const stored = ctx.store.getAuthSession(tokenHash);
      assert(stored, '登录后没有会话记录');
      ctx.store.touchAuthSession(
        tokenHash,
        new Date(Date.now() - 10 * 60_000).toISOString(),
        stored.expiresAt,
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/system/overview',
        headers: { cookie: cookieHeader(token) },
      });
      assert(response.statusCode === 200, `状态码 ${response.statusCode}`);
      assert(response.headers['set-cookie'] === undefined, '非保持登录的会话也被续期了');
      const after = ctx.store.getAuthSession(tokenHash);
      assert(after?.expiresAt === stored.expiresAt, '非保持登录的会话被顺延了');
      return '12 小时上限不变';
    });

    await expect('过期的会话 token → 401 并清理', async () => {
      const expired = 'expired-token-for-check';
      ctx.store.createAuthSession({
        tokenHash: hashSessionToken(expired),
        username: 'admin',
        persistent: true,
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const response = await app.inject({
        method: 'GET',
        url: '/api/system/overview',
        headers: { cookie: cookieHeader(expired) },
      });
      assert(response.statusCode === 401, `状态码 ${response.statusCode}`);
      assert(ctx.store.getAuthSession(hashSessionToken(expired)) === null, '过期会话未被清理');
      return 'HTTP 401';
    });

    process.stdout.write('\n修改账号与密码：\n');

    await expect('当前密码错误时拒绝修改 → 400', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/auth/credentials',
        headers: { cookie: cookieHeader(sessionToken) },
        payload: { currentPassword: 'nope', username: 'moln' },
      });
      assert(response.statusCode === 400, `状态码 ${response.statusCode}`);
      return 'HTTP 400';
    });

    await expect('用户名过短时拒绝修改 → 400', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/auth/credentials',
        headers: { cookie: cookieHeader(sessionToken) },
        payload: { currentPassword: 'admin', username: 'a' },
      });
      assert(response.statusCode === 400, `状态码 ${response.statusCode}`);
      return 'HTTP 400';
    });

    await expect('只改用户名不改密码时仍提示使用默认密码', async () => {
      // 「仍在使用默认密码」是弱口令提示，只能由密码决定。原先的判定同时要求
      // 用户名仍是 admin，于是「先改名、后改密码」的用户一改名提示就消失了，
      // 出厂口令却还在。
      const rename = await app.inject({
        method: 'PUT',
        url: '/api/auth/credentials',
        headers: { cookie: cookieHeader(sessionToken) },
        payload: { currentPassword: 'admin', username: 'ops' },
      });
      assert(rename.statusCode === 200, `状态码 ${rename.statusCode}`);
      const renamed = rename.json<AuthSessionPayload>();
      assert(renamed.session?.username === 'ops', '用户名未更新');
      assert(
        renamed.credentials?.defaultCredentials === true,
        '改名后不再提示仍在使用默认密码（弱口令提示消失）',
      );
      sessionToken = cookieToken(rename.headers['set-cookie']);

      // 密码确实没变，所以出厂口令仍能登录：提示与事实一致。
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'ops', password: 'admin' },
      });
      assert(login.statusCode === 200, `改名后默认密码无法登录（${login.statusCode}）`);

      // 改回 admin，后续用例继续沿用出厂账号。
      const restore = await app.inject({
        method: 'PUT',
        url: '/api/auth/credentials',
        headers: { cookie: cookieHeader(sessionToken) },
        payload: { currentPassword: 'admin', username: 'admin' },
      });
      assert(restore.statusCode === 200, `状态码 ${restore.statusCode}`);
      assert(
        restore.json<AuthSessionPayload>().credentials?.defaultCredentials === true,
        '改回原名后默认密码提示消失',
      );
      sessionToken = cookieToken(restore.headers['set-cookie']);
      return 'defaultCredentials 保持 true';
    });

    await expect('修改账号与密码后当前浏览器继续可用，会话 token 已轮换', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/auth/credentials',
        headers: { cookie: cookieHeader(sessionToken) },
        payload: { currentPassword: 'admin', username: 'moln', password: 's3cret-pw' },
      });
      assert(response.statusCode === 200, `状态码 ${response.statusCode}`);
      const payload = response.json<AuthSessionPayload>();
      assert(payload.session?.username === 'moln', '用户名未更新');
      assert(payload.credentials?.defaultCredentials === false, '默认密码标记未清除');

      const rotated = cookieToken(response.headers['set-cookie']);
      assert(rotated !== sessionToken, '会话 token 未轮换');

      const withOld = await app.inject({
        method: 'GET',
        url: '/api/system/overview',
        headers: { cookie: cookieHeader(sessionToken) },
      });
      assert(withOld.statusCode === 401, `旧 token 仍可用（${withOld.statusCode}）`);

      const withNew = await app.inject({
        method: 'GET',
        url: '/api/system/overview',
        headers: { cookie: cookieHeader(rotated) },
      });
      assert(withNew.statusCode === 200, `新 token 不可用（${withNew.statusCode}）`);
      sessionToken = rotated;
      return '会话已轮换';
    });

    await expect('把密码改回出厂值后弱口令提示恢复（defaultCredentials=true）', async () => {
      // 提示必须跟着「库里的口令还是不是 admin」走，而不是跟「有没有调用过改密
      // 接口」走：用户把密码显式改回 admin 后出厂口令重新可用，界面却不再提醒，
      // 弱口令就这样留在生产环境里。
      const revert = await app.inject({
        method: 'PUT',
        url: '/api/auth/credentials',
        headers: { cookie: cookieHeader(sessionToken) },
        payload: { currentPassword: 's3cret-pw', password: 'admin' },
      });
      assert(revert.statusCode === 200, `状态码 ${revert.statusCode}`);
      assert(
        revert.json<AuthSessionPayload>().credentials?.defaultCredentials === true,
        '密码已改回出厂值，弱口令提示却没有恢复',
      );
      assert(
        ctx.store.getAuthAccount()?.passwordChangedAt === null,
        'password_changed_at 没有随「改回出厂密码」一起清空',
      );
      sessionToken = cookieToken(revert.headers['set-cookie']);

      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'moln', password: 'admin' },
      });
      assert(login.statusCode === 200, `出厂口令无法登录（${login.statusCode}）`);

      // 换回非出厂口令，后续用例继续按原密码推进。
      const restore = await app.inject({
        method: 'PUT',
        url: '/api/auth/credentials',
        headers: { cookie: cookieHeader(sessionToken) },
        payload: { currentPassword: 'admin', password: 's3cret-pw' },
      });
      assert(restore.statusCode === 200, `还原密码失败：${restore.statusCode}`);
      assert(
        restore.json<AuthSessionPayload>().credentials?.defaultCredentials === false,
        '重新设成非出厂密码后弱口令提示没有消失',
      );
      sessionToken = cookieToken(restore.headers['set-cookie']);
      return 'defaultCredentials true → false';
    });

    await expect('旧密码无法登录，新密码可以登录', async () => {
      const oldLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'admin' },
      });
      assert(oldLogin.statusCode === 401, `旧密码仍可登录（${oldLogin.statusCode}）`);

      const newLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'moln', password: 's3cret-pw' },
      });
      assert(newLogin.statusCode === 200, `新密码无法登录（${newLogin.statusCode}）`);
      return 'HTTP 200';
    });

    await expect('修改凭据后其他设备的会话立即失效', async () => {
      const other = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'moln', password: 's3cret-pw' },
      });
      const otherToken = cookieToken(other.headers['set-cookie']);

      const rotate = await app.inject({
        method: 'PUT',
        url: '/api/auth/credentials',
        headers: { cookie: cookieHeader(sessionToken) },
        payload: { currentPassword: 's3cret-pw', password: 's3cret-pw-2' },
      });
      assert(rotate.statusCode === 200, `状态码 ${rotate.statusCode}`);
      sessionToken = cookieToken(rotate.headers['set-cookie']);

      const response = await app.inject({
        method: 'GET',
        url: '/api/system/overview',
        headers: { cookie: cookieHeader(otherToken) },
      });
      assert(response.statusCode === 401, `其他会话仍然可用（${response.statusCode}）`);
      return 'HTTP 401';
    });

    await expect('没有实际改动的 PUT 不轮换会话、不登出其他设备', async () => {
      // 设置页每次保存都会把当前用户名原样提交，所以「用户名相同 + 密码留空」
      // 正是空保存的样子。旧实现无条件轮换，于是这样一次请求就把其他设备全部
      // 登出；现在它必须原样返回调用方自己的会话，别动任何一行会话数据。
      const other = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'moln', password: 's3cret-pw-2' },
      });
      const otherToken = cookieToken(other.headers['set-cookie']);
      const sessionsBefore = ctx.store.countAuthSessions(nowIso());
      const accountBefore = ctx.store.getAuthAccount();

      const response = await app.inject({
        method: 'PUT',
        url: '/api/auth/credentials',
        headers: { cookie: cookieHeader(sessionToken) },
        payload: { currentPassword: 's3cret-pw-2', username: 'moln', password: null },
      });
      assert(response.statusCode === 200, `状态码 ${response.statusCode}`);
      const payload = response.json<AuthSessionPayload & { rotated?: boolean }>();
      assert(payload.rotated === false, '空保存没有回答「未改动」（rotated 缺失或为 true）');
      assert(payload.session?.username === 'moln', '空保存改掉了会话里的用户名');
      assert(response.headers['set-cookie'] === undefined, '空保存仍然下发了新的会话 Cookie');
      assert(
        ctx.store.countAuthSessions(nowIso()) === sessionsBefore,
        `空保存改动了会话数量（${sessionsBefore} → ${ctx.store.countAuthSessions(nowIso())}）`,
      );
      assert(
        ctx.store.getAuthAccount()?.updatedAt === accountBefore?.updatedAt,
        '空保存仍然写入了 auth_account',
      );

      const otherStill = await app.inject({
        method: 'GET',
        url: '/api/system/overview',
        headers: { cookie: cookieHeader(otherToken) },
      });
      assert(otherStill.statusCode === 200, `其他设备被空保存登出（${otherStill.statusCode}）`);

      const mine = await app.inject({
        method: 'GET',
        url: '/api/system/overview',
        headers: { cookie: cookieHeader(sessionToken) },
      });
      assert(mine.statusCode === 200, `调用方自己的会话被空保存登出（${mine.statusCode}）`);
      return 'HTTP 200（rotated=false，无新 Cookie，其他设备仍在）';
    });

    await expect('把当前密码原样提交、用户名只改大小写都不算改动', async () => {
      // 「未改动」按库里的凭据判定，而不是「请求带了哪些字段」：与登录、会话校验
      // 同一套比较（用户名大小写不敏感），密码也要真的与库里不同才算改密码。
      const sessionsBefore = ctx.store.countAuthSessions(nowIso());

      const samePassword = await app.inject({
        method: 'PUT',
        url: '/api/auth/credentials',
        headers: { cookie: cookieHeader(sessionToken) },
        payload: { currentPassword: 's3cret-pw-2', password: 's3cret-pw-2' },
      });
      assert(samePassword.statusCode === 200, `状态码 ${samePassword.statusCode}`);
      assert(
        samePassword.json<AuthSessionPayload & { rotated?: boolean }>().rotated === false,
        '把当前密码原样填回来被当成了改密码',
      );

      const casing = await app.inject({
        method: 'PUT',
        url: '/api/auth/credentials',
        headers: { cookie: cookieHeader(sessionToken) },
        payload: { currentPassword: 's3cret-pw-2', username: 'MOLN' },
      });
      assert(casing.statusCode === 200, `状态码 ${casing.statusCode}`);
      assert(
        casing.json<AuthSessionPayload & { rotated?: boolean }>().rotated === false,
        '用户名只换大小写被当成了改名',
      );
      assert(
        ctx.store.getAuthAccount()?.username === 'moln',
        '大小写不同的用户名被写进了 auth_account',
      );

      const sessionsAfter = ctx.store.countAuthSessions(nowIso());
      assert(
        sessionsAfter === sessionsBefore,
        `会话数量发生了变化（${sessionsBefore} → ${sessionsAfter}）`,
      );
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'MOLN', password: 's3cret-pw-2' },
      });
      assert(login.statusCode === 200, `大小写不同的用户名无法登录（${login.statusCode}）`);
      ctx.auth.logout(cookieToken(login.headers['set-cookie']));
      return '两次 200（rotated=false），会话数量不变';
    });

    process.stdout.write('\n退出登录：\n');

    await expect('退出登录清除 cookie 并吊销会话', async () => {
      const logout = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: cookieHeader(sessionToken) },
      });
      assert(logout.statusCode === 200, `状态码 ${logout.statusCode}`);
      const header = String(logout.headers['set-cookie'] ?? '');
      assert(/max-age=0/i.test(header), '未清除 cookie');

      const response = await app.inject({
        method: 'GET',
        url: '/api/system/overview',
        headers: { cookie: cookieHeader(sessionToken) },
      });
      assert(response.statusCode === 401, `会话仍然有效（${response.statusCode}）`);
      return 'HTTP 200 + 401';
    });

    process.stdout.write('\n启动模式与实时来源策略：\n');

    await expect('编译产物（pnpm start）默认进入生产模式，显式 NODE_ENV 优先', async () => {
      // README 记录的生产启动是 `pnpm build` + `pnpm start`，而 npm 脚本无法跨平台
      // 导出 NODE_ENV：旧实现让这条路径退回开发策略，实时通道因此对本机任意端口的
      // 页面开放。编译入口（dist/*.js）现在默认 production，tsx 加载源码时保持开发
      // 默认，两者都可以用显式 NODE_ENV 覆盖。
      const compiled: Record<string, string | undefined> = {};
      applyDefaultNodeEnv('file:///srv/autogit/apps/server/dist/index.js', compiled);
      assert(
        compiled.NODE_ENV === 'production',
        `编译入口没有默认到生产模式：${compiled.NODE_ENV ?? '(未设置)'}`,
      );

      const explicit: Record<string, string | undefined> = { NODE_ENV: 'development' };
      applyDefaultNodeEnv('file:///srv/autogit/apps/server/dist/index.js', explicit);
      assert(explicit.NODE_ENV === 'development', '显式 NODE_ENV 被默认值覆盖');

      const source: Record<string, string | undefined> = {};
      applyDefaultNodeEnv('file:///srv/autogit/apps/server/src/index.ts', source);
      assert(source.NODE_ENV === undefined, `tsx 开发入口被改成生产模式：${source.NODE_ENV}`);
      assert(
        !isCompiledEntry('file:///srv/autogit/apps/server/src/index.ts'),
        'TypeScript 源码被当成编译产物',
      );
      return 'dist → production，src → 保持开发默认';
    });

    await expect('AUTOGIT_DEV_ORIGINS 只在开发模式生效', async () => {
      const savedNodeEnv = process.env.NODE_ENV;
      const savedDevOrigins = process.env.AUTOGIT_DEV_ORIGINS;
      try {
        process.env.NODE_ENV = 'development';
        process.env.AUTOGIT_DEV_ORIGINS = 'http://localhost:6001';
        const dev = loadRuntimeConfig();
        assert(
          dev.devOrigins.join(',') === 'http://localhost:6001',
          `开发来源解析异常：${dev.devOrigins.join('、') || '(空)'}`,
        );

        process.env.NODE_ENV = 'production';
        const prod = loadRuntimeConfig();
        assert(prod.isDev === false, '生产模式未生效');
        assert(
          prod.devOrigins.length === 0,
          `生产模式忽略开发来源失败：${prod.devOrigins.join('、')}`,
        );
        return '开发 6001、生产 0 条';
      } finally {
        restoreEnv('NODE_ENV', savedNodeEnv);
        restoreEnv('AUTOGIT_DEV_ORIGINS', savedDevOrigins);
      }
    });

    process.stdout.write('\n实时通道会话吊销（真实 HTTP + WebSocket 升级）：\n');

    // A WebSocket upgrade cannot go through `app.inject()`, so this block drives a
    // real listener the way a browser does.
    await app.listen({ host: '127.0.0.1', port: 0 });
    const realtimePort = listeningPort(app);

    await expect('未登录升级实时通道 → 401', async () => {
      const result = await upgradeRealtime(realtimePort, '/api/realtime', null);
      assert(!result.upgraded, '未登录也能建立实时连接');
      assert(result.statusCode === 401, `状态码 ${result.statusCode}`);
      return 'HTTP 401';
    });

    await expect('百分号编码路径不能绕过实时通道门禁（/%61pi/realtime → 401）', async () => {
      const result = await upgradeRealtime(realtimePort, '/%61pi/realtime', null);
      assert(!result.upgraded, '编码路径绕过了实时通道门禁');
      assert(result.statusCode === 401, `状态码 ${result.statusCode}`);
      return 'HTTP 401';
    });

    let revokedToken = '';
    await expect('登录后可以建立实时连接并收到欢迎消息（101）', async () => {
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'moln', password: 's3cret-pw-2', remember: true },
      });
      assert(login.statusCode === 200, `登录失败：${login.statusCode}`);
      revokedToken = cookieToken(login.headers['set-cookie']);

      const result = await upgradeRealtime(
        realtimePort,
        '/api/realtime',
        cookieHeader(revokedToken),
      );
      assert(result.upgraded, '有效会话未能升级实时通道');
      realtimeProbes.push(result.probe);
      assert(await result.probe.waitForFrame(3_000), '升级后没有收到服务端消息');
      return 'HTTP 101';
    });

    await expect('跨站 Origin 的实时升级被拒绝（403，未登录仍 401）', async () => {
      // 升级请求拿不到 CORS 层，响应也是 101 而不是可读的 JSON，所以「浏览器
      // 会不会带上 SameSite=Lax 的 Cookie」成了唯一防线。这里把 Origin 与 Host
      // 的比对放进服务端自己的守卫里，跨站页面即使拿到有效 Cookie 也连不上。
      const before = realtimeProbes.length;
      const crossSite = await upgradeRealtime(
        realtimePort,
        '/api/realtime',
        cookieHeader(revokedToken),
        'https://evil.example',
      );
      assert(!crossSite.upgraded, '跨站来源仍能建立实时连接');
      assert(crossSite.statusCode === 403, `状态码 ${crossSite.statusCode}`);

      // 会话校验优先：没登录时仍是 401，不透露「这个来源可不可信」。
      const anonymous = await upgradeRealtime(
        realtimePort,
        '/api/realtime',
        null,
        'https://evil.example',
      );
      assert(!anonymous.upgraded, '未登录的跨站升级被放行');
      assert(anonymous.statusCode === 401, `未登录跨站升级 → ${anonymous.statusCode}`);

      // 编码路径命中的是同一条路由，同样要过这道校验。
      const encoded = await upgradeRealtime(
        realtimePort,
        '/%61pi/realtime',
        cookieHeader(revokedToken),
        'https://evil.example',
      );
      assert(!encoded.upgraded, '编码路径绕过了来源校验');
      assert(encoded.statusCode === 403, `编码路径状态码 ${encoded.statusCode}`);
      assert(realtimeProbes.length === before, '被拒绝的升级留下了连接');
      return 'HTTP 403（未登录 401）';
    });

    await expect('同源与 Vite 开发来源的实时升级正常（101），其它本地端口 403', async () => {
      const sameOrigin = await upgradeRealtime(
        realtimePort,
        '/api/realtime',
        cookieHeader(revokedToken),
        `http://127.0.0.1:${realtimePort}`,
      );
      assert(sameOrigin.upgraded, '同源 Origin 被拒绝');
      realtimeProbes.push(sameOrigin.probe);
      assert(await sameOrigin.probe.waitForFrame(3_000), '同源连接没有收到服务端消息');

      // 开发模式：Vite 代理用 changeOrigin 把 Host 改写成后端地址，Origin 仍是
      // http://localhost:5173，所以这个来源要放行（生产模式见下一个用例）。
      const devOrigin = await upgradeRealtime(
        realtimePort,
        '/api/realtime',
        cookieHeader(revokedToken),
        'http://localhost:5173',
      );
      assert(devOrigin.upgraded, 'Vite 开发来源被拒绝');
      realtimeProbes.push(devOrigin.probe);
      assert(await devOrigin.probe.waitForFrame(3_000), 'Vite 开发连接没有收到服务端消息');

      // 放行范围只到 Vite 自己的端口为止。本机其它端口的页面对于 127.0.0.1 而言
      // 是同站（Lax Cookie 会随握手一起发出），旧实现「任意回环来源都放行」等于
      // 让它们也能订阅任务日志与 AI 输出。
      const otherLocalPort = await upgradeRealtime(
        realtimePort,
        '/api/realtime',
        cookieHeader(revokedToken),
        'http://127.0.0.1:9999',
      );
      assert(!otherLocalPort.upgraded, '其它本地端口仍然可以建立实时连接');
      assert(otherLocalPort.statusCode === 403, `其它本地端口 → ${otherLocalPort.statusCode}`);

      // 开发来源写成 `http://localhost:5173`，比较的就是完整 origin：同一主机的
      // `https://localhost:5173` 是另一个 origin，旧实现只比 host[:port]，会把它
      // 和真正的开发来源一起放行（README 的措辞是「只接受同源与显式列出的来源」）。
      const schemeMismatch = await upgradeRealtime(
        realtimePort,
        '/api/realtime',
        cookieHeader(revokedToken),
        'https://localhost:5173',
      );
      assert(!schemeMismatch.upgraded, '开发来源只比对了主机，协议不一致也被放行');
      assert(schemeMismatch.statusCode === 403, `协议不一致 → ${schemeMismatch.statusCode}`);
      return 'HTTP 101 ×2、其它本地端口 403、协议不一致 403';
    });

    await expect('生产模式不放行回环 Origin，显式允许列表可放行', async () => {
      const prodHome = mkdtempSync(path.join(tmpdir(), 'autogit-auth-prod-'));
      const savedNodeEnv = process.env.NODE_ENV;
      const savedHome = process.env.AUTOGIT_HOME;
      const savedAllowed = process.env.AUTOGIT_ALLOWED_ORIGINS;
      let prod: Awaited<ReturnType<typeof buildServer>> | null = null;
      process.env.NODE_ENV = 'production';
      process.env.AUTOGIT_HOME = prodHome;
      process.env.AUTOGIT_ALLOWED_ORIGINS = 'https://autogit.example.com';
      try {
        const prodConfig = loadRuntimeConfig();
        // 生产模式的日志是 JSON，别让「已创建默认账号」的告警混进自检输出。
        prodConfig.logLevel = 'error';
        assert(prodConfig.isDev === false, '未按生产模式加载配置');
        assert(
          prodConfig.allowedOrigins.length === 1,
          `允许列表解析异常：${prodConfig.allowedOrigins.join('、')}`,
        );
        assert(
          prodConfig.devOrigins.length === 0,
          `生产模式仍然信任开发来源：${prodConfig.devOrigins.join('、')}`,
        );

        // `AUTOGIT_ALLOWED_ORIGINS` 按完整 origin（协议 + 主机 + 端口）比对：条目里
        // 写了协议就锁定协议，同一主机的 `http://` 来源（降级页面、恶意页）不再自动
        // 获得信任；只写主机名的条目保留「只比主机」的旧语义，避免旧配置被锁在实时
        // 通道外，README 与 .env.example 都建议写全协议。
        const listedOrigin = (origin: string, allowedOrigins: string[]): boolean =>
          isTrustedOrigin(
            { protocol: 'http', headers: { host: '127.0.0.1:4711', origin } },
            { allowedOrigins },
          );
        assert(
          listedOrigin('https://autogit.example.com', ['https://autogit.example.com']),
          '允许列表没有放行同一 origin',
        );
        assert(
          !listedOrigin('http://autogit.example.com', ['https://autogit.example.com']),
          '允许列表忽略了协议差异（https 条目放行了 http 来源）',
        );
        assert(
          listedOrigin('http://autogit.example.com', ['autogit.example.com']),
          '裸主机条目不再放行，旧配置会被锁在实时通道外',
        );

        prod = await buildServer(prodConfig);
        await prod.app.listen({ host: '127.0.0.1', port: 0 });
        const prodPort = listeningPort(prod.app);
        const login = await prod.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: 'admin' },
        });
        assert(login.statusCode === 200, `生产实例登录失败：${login.statusCode}`);
        const cookie = cookieHeader(cookieToken(login.headers['set-cookie']));

        const loopback = await upgradeRealtime(
          prodPort,
          '/api/realtime',
          cookie,
          'http://localhost:5173',
        );
        assert(!loopback.upgraded, '生产模式仍然放行 Vite 开发来源');
        assert(loopback.statusCode === 403, `生产模式开发来源 → ${loopback.statusCode}`);

        // 生产模式连「其它本地端口」也不再有任何隐式放行。
        const otherLocalPort = await upgradeRealtime(
          prodPort,
          '/api/realtime',
          cookie,
          'http://127.0.0.1:9999',
        );
        assert(!otherLocalPort.upgraded, '生产模式仍然放行其它回环端口');
        assert(
          otherLocalPort.statusCode === 403,
          `生产模式本地端口 → ${otherLocalPort.statusCode}`,
        );

        const sameOrigin = await upgradeRealtime(
          prodPort,
          '/api/realtime',
          cookie,
          `http://127.0.0.1:${prodPort}`,
        );
        assert(sameOrigin.upgraded, '生产模式下同源被拒绝');
        sameOrigin.probe.destroy();

        const allowed = await upgradeRealtime(
          prodPort,
          '/api/realtime',
          cookie,
          'https://autogit.example.com',
        );
        assert(allowed.upgraded, '显式允许列表未生效');
        allowed.probe.destroy();

        // 允许列表条目带协议后，同一主机的另一种协议不再被放行。
        const downgraded = await upgradeRealtime(
          prodPort,
          '/api/realtime',
          cookie,
          'http://autogit.example.com',
        );
        assert(!downgraded.upgraded, '允许列表只比对了主机，http:// 来源被放行');
        assert(downgraded.statusCode === 403, `协议降级 → ${downgraded.statusCode}`);

        // 写请求用的是同一个策略对象，生产模式下开发来源与本地端口同样进不来，
        // 允许列表与同源的写请求照常放行。
        const devWrite = await prod.app.inject({
          method: 'POST',
          url: '/api/orchestrator/restart',
          headers: { cookie, origin: 'http://localhost:5173' },
        });
        assert(
          devWrite.statusCode === 403,
          `生产模式放行开发来源的写请求 → ${devWrite.statusCode}`,
        );

        const localWrite = await prod.app.inject({
          method: 'POST',
          url: '/api/orchestrator/restart',
          headers: { cookie, origin: 'http://127.0.0.1:9999' },
        });
        assert(
          localWrite.statusCode === 403,
          `生产模式放行本地端口的写请求 → ${localWrite.statusCode}`,
        );

        const listedWrite = await prod.app.inject({
          method: 'POST',
          url: '/api/orchestrator/restart',
          headers: { cookie, origin: 'https://autogit.example.com' },
        });
        assert(listedWrite.statusCode === 200, `允许列表内的写请求 → ${listedWrite.statusCode}`);

        const prodSameOriginWrite = await prod.app.inject({
          method: 'POST',
          url: '/api/orchestrator/restart',
          headers: {
            cookie,
            host: `127.0.0.1:${prodPort}`,
            origin: `http://127.0.0.1:${prodPort}`,
          },
        });
        assert(
          prodSameOriginWrite.statusCode === 200,
          `生产模式同源写请求 → ${prodSameOriginWrite.statusCode}`,
        );
      } finally {
        restoreEnv('NODE_ENV', savedNodeEnv);
        restoreEnv('AUTOGIT_HOME', savedHome);
        restoreEnv('AUTOGIT_ALLOWED_ORIGINS', savedAllowed);
        // 关掉实例再删目录：断言失败时也要先释放 SQLite 句柄，否则 Windows
        // 上 rmSync 会抛出 EBUSY 掩盖真正的失败原因。
        if (prod) {
          await prod.app.close().catch(() => undefined);
          prod.ctx.dispose();
        }
        rmSync(prodHome, { recursive: true, force: true });
      }
      return '开发来源 403、本地端口 403、同源 101、允许列表 101、协议降级 403、写请求同一策略（开发来源与本地端口 403、允许列表与同源 200）';
    });

    let rotatedToken = '';
    await expect('改凭据只让发起方重连（4402），其他设备的连接被吊销（4401）', async () => {
      // 另一台设备的会话：它的 Cookie 与发起方不同，改密码后必须真的掉线。
      const other = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'moln', password: 's3cret-pw-2' },
      });
      assert(other.statusCode === 200, `另一台设备登录失败：${other.statusCode}`);
      const otherToken = cookieToken(other.headers['set-cookie']);
      const otherUpgrade = await upgradeRealtime(
        realtimePort,
        '/api/realtime',
        cookieHeader(otherToken),
      );
      assert(otherUpgrade.upgraded, '另一台设备未能升级实时通道');
      const otherProbe = otherUpgrade.probe;
      realtimeProbes.push(otherProbe);
      assert(await otherProbe.waitForFrame(3_000), '另一台设备的连接没有收到服务端消息');

      const result = await upgradeRealtime(
        realtimePort,
        '/api/realtime',
        cookieHeader(revokedToken),
      );
      assert(result.upgraded, '有效会话未能升级实时通道');
      const probe = result.probe;
      realtimeProbes.push(probe);
      assert(await probe.waitForFrame(3_000), '升级后没有收到服务端消息');

      const rotate = await app.inject({
        method: 'PUT',
        url: '/api/auth/credentials',
        headers: { cookie: cookieHeader(revokedToken) },
        payload: { currentPassword: 's3cret-pw-2', password: 's3cret-pw-3' },
      });
      assert(rotate.statusCode === 200, `轮换凭据失败：${rotate.statusCode}`);
      rotatedToken = cookieToken(rotate.headers['set-cookie']);

      const outcome = await probe.waitForClose(3_000);
      assert(outcome.closed, '改凭据后旧连接仍然存活');
      // 发起方拿到的是「重连」而不是「登出」：同一个 200 响应里带着新 Cookie，
      // 用 4401 关掉它会让用户在改密码成功的一瞬间看到登录页闪一下。
      assert(outcome.code === SESSION_ROTATED_CLOSE_CODE, `发起方关闭码 ${outcome.code}`);

      const otherOutcome = await otherProbe.waitForClose(3_000);
      assert(otherOutcome.closed, '另一台设备改凭据后连接仍然存活');
      assert(
        otherOutcome.code === SESSION_GONE_CLOSE_CODE,
        `另一台设备关闭码 ${otherOutcome.code}`,
      );
      return `发起方 ${SESSION_ROTATED_CLOSE_CODE}、另一台设备 ${SESSION_GONE_CLOSE_CODE}`;
    });

    await expect('轮换后的新会话可继续使用，退出登录时关闭连接（4401）', async () => {
      const result = await upgradeRealtime(
        realtimePort,
        '/api/realtime',
        cookieHeader(rotatedToken),
      );
      assert(result.upgraded, '轮换后的会话未能升级实时通道');
      const probe = result.probe;
      realtimeProbes.push(probe);
      assert(await probe.waitForFrame(3_000), '升级后没有收到服务端消息');

      const logout = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: cookieHeader(rotatedToken) },
      });
      assert(logout.statusCode === 200, `退出登录失败：${logout.statusCode}`);

      const outcome = await probe.waitForClose(3_000);
      assert(outcome.closed, '退出登录后连接仍然存活');
      assert(outcome.code === SESSION_GONE_CLOSE_CODE, `关闭码 ${outcome.code}`);
      return `${SESSION_GONE_CLOSE_CODE} 关闭`;
    });

    process.stdout.write('\n反向代理终结 TLS（AUTOGIT_TRUST_PROXY）：\n');

    await expect('AUTOGIT_TRUST_PROXY 解析：默认关闭，开 / 关 / 地址列表', async () => {
      const saved = process.env.AUTOGIT_TRUST_PROXY;
      try {
        delete process.env.AUTOGIT_TRUST_PROXY;
        assert(loadRuntimeConfig().trustProxy === false, '默认值不再是「不信任代理」');
        for (const value of ['1', 'true', 'yes', 'on']) {
          process.env.AUTOGIT_TRUST_PROXY = value;
          assert(loadRuntimeConfig().trustProxy === true, `AUTOGIT_TRUST_PROXY=${value} 未开启`);
        }
        for (const value of ['0', 'false', 'no', 'off']) {
          process.env.AUTOGIT_TRUST_PROXY = value;
          assert(loadRuntimeConfig().trustProxy === false, `AUTOGIT_TRUST_PROXY=${value} 未关闭`);
        }
        process.env.AUTOGIT_TRUST_PROXY = '127.0.0.1,::1';
        const listed = loadRuntimeConfig().trustProxy;
        assert(listed === '127.0.0.1,::1', `地址列表被改写：${String(listed)}`);
      } finally {
        restoreEnv('AUTOGIT_TRUST_PROXY', saved);
      }
      return '默认 false、1/true/yes/on → true、0/false/no/off → false、地址列表原样透传';
    });

    await expect('代理终结 TLS 时会话 Cookie 带 Secure（含续期与清除）', async () => {
      // The session cookie used to decide `Secure` from `request.protocol` alone,
      // and behind a TLS-terminating proxy that is always `http`. With the switch
      // on, Fastify folds `X-Forwarded-Proto` in, so login, the sliding renewal
      // (the `onSend` hook) and the logout clearing counter-part all carry it.
      const proxiedHome = mkdtempSync(path.join(tmpdir(), 'autogit-auth-proxy-'));
      const savedTrust = process.env.AUTOGIT_TRUST_PROXY;
      const savedHome = process.env.AUTOGIT_HOME;
      process.env.AUTOGIT_TRUST_PROXY = '1';
      process.env.AUTOGIT_HOME = proxiedHome;
      let proxied: Awaited<ReturnType<typeof buildServer>> | null = null;
      try {
        const proxiedConfig = loadRuntimeConfig();
        // 生产模式的日志是 JSON，别让「已创建默认账号」的告警混进自检输出。
        proxiedConfig.logLevel = 'error';
        assert(proxiedConfig.trustProxy === true, '配置没有把 trustProxy 交给 Fastify');
        proxied = await buildServer(proxiedConfig);
        await proxied.app.ready();

        const login = await proxied.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-forwarded-proto': 'https' },
          payload: { username: 'admin', password: 'admin', remember: true },
        });
        assert(login.statusCode === 200, `代理后登录失败：${login.statusCode}`);
        const loginCookie = String(login.headers['set-cookie'] ?? '');
        assert(/;\s*Secure/i.test(loginCookie), `登录 Cookie 缺少 Secure：${loginCookie}`);
        const token = cookieToken(login.headers['set-cookie']);
        const tokenHash = hashSessionToken(token);

        const stored = proxied.ctx.store.getAuthSession(tokenHash);
        assert(stored, '登录后没有会话记录');
        proxied.ctx.store.touchAuthSession(
          tokenHash,
          new Date(Date.now() - 10 * 60_000).toISOString(),
          new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
        );
        const renewed = await proxied.app.inject({
          method: 'GET',
          url: '/api/system/overview',
          headers: { cookie: cookieHeader(token), 'x-forwarded-proto': 'https' },
        });
        assert(renewed.statusCode === 200, `代理后读取失败：${renewed.statusCode}`);
        const renewedCookie = String(renewed.headers['set-cookie'] ?? '');
        assert(/max-age=\d+/i.test(renewedCookie), `续期未下发 Cookie：${renewedCookie || '(空)'}`);
        assert(/;\s*Secure/i.test(renewedCookie), `续期 Cookie 缺少 Secure：${renewedCookie}`);

        // 清除 Cookie 的属性要和下发时一致，否则同名 Cookie 可能留在浏览器里。
        const logout = await proxied.app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { cookie: cookieHeader(token), 'x-forwarded-proto': 'https' },
        });
        assert(logout.statusCode === 200, `代理后退出登录失败：${logout.statusCode}`);
        const cleared = String(logout.headers['set-cookie'] ?? '');
        assert(/max-age=0/i.test(cleared), `清除 Cookie 缺少 Max-Age=0：${cleared}`);
        assert(/;\s*Secure/i.test(cleared), `清除 Cookie 缺少 Secure：${cleared}`);

        // 代理报告明文时不能标 Secure：那会把纯 HTTP 部署（含 127.0.0.1）
        // 直接锁在登录页外。
        const plainLogin = await proxied.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-forwarded-proto': 'http' },
          payload: { username: 'admin', password: 'admin', remember: true },
        });
        assert(plainLogin.statusCode === 200, `明文代理登录失败：${plainLogin.statusCode}`);
        const plainCookie = String(plainLogin.headers['set-cookie'] ?? '');
        assert(!/;\s*Secure/i.test(plainCookie), `明文代理被标成 Secure：${plainCookie}`);
        return '登录 / 续期 / 清除 Cookie 带 Secure，x-forwarded-proto: http 不带';
      } finally {
        restoreEnv('AUTOGIT_TRUST_PROXY', savedTrust);
        restoreEnv('AUTOGIT_HOME', savedHome);
        if (proxied) {
          await proxied.app.close().catch(() => undefined);
          proxied.ctx.dispose();
        }
        rmSync(proxiedHome, { recursive: true, force: true });
      }
    });

    await expect('未开启开关时忽略 X-Forwarded-Proto（直连不可被伪造）', async () => {
      // 默认部署下这个请求头只是客户端输入：能直连端口的人不该能决定 Cookie
      // 属性（`Secure` 会让同一个 Cookie 在明文回环上失效；反过来把它去掉也
      // 不该由外部输入决定）。
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-proto': 'https' },
        payload: { username: 'moln', password: 's3cret-pw-3', remember: true },
      });
      assert(response.statusCode === 200, `登录失败：${response.statusCode}`);
      const header = String(response.headers['set-cookie'] ?? '');
      assert(
        !/;\s*Secure/i.test(header),
        `默认配置就采信了转发头，Cookie 带上了 Secure：${header}`,
      );
      return 'Cookie 仍是 HttpOnly; SameSite=Lax（无 Secure）';
    });

    process.stdout.write('\n登录失败限速（暴力破解成本）：\n');

    await expect('连续登录失败后限速 429，窗口过后自动恢复并清零', async () => {
      const attempt = async (password: string): Promise<number> => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'moln', password },
        });
        return response.statusCode;
      };

      // The pause only gates new logins: a browser that is already signed in keeps
      // working, so nobody can use the backoff to lock the owner out.
      const existing = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'moln', password: 's3cret-pw-3' },
      });
      assert(existing.statusCode === 200, `准备已登录会话失败：${existing.statusCode}`);
      const existingToken = cookieToken(existing.headers['set-cookie']);

      const free: number[] = [];
      for (let index = 0; index < AUTH_LOGIN_FAILURE_LIMIT; index += 1) {
        free.push(await attempt('definitely-wrong'));
      }
      assert(
        free.every((status) => status === 401),
        `前 ${AUTH_LOGIN_FAILURE_LIMIT} 次应照常校验密码：${free.join('、')}`,
      );

      // Even the correct password waits out the window: the endpoint stops
      // verifying anything until the pause expires.
      const limited = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'moln', password: 's3cret-pw-3' },
      });
      assert(limited.statusCode === 429, `超出失败次数后未限速：${limited.statusCode}`);
      const { error: limitedMessage } = limited.json<{ error: string }>();
      assert(/秒后重试/.test(limitedMessage), `限速提示文案异常：${limitedMessage}`);

      const stillSignedIn = await app.inject({
        method: 'GET',
        url: '/api/system/overview',
        headers: { cookie: cookieHeader(existingToken) },
      });
      assert(
        stillSignedIn.statusCode === 200,
        `限速期间已登录会话被拒：${stillSignedIn.statusCode}`,
      );

      // The penalty is a pause, not a lockout: it expires by itself, the right
      // password works again, and that success clears the counter.
      await delay(AUTH_LOGIN_BACKOFF_MS + 300);
      assert((await attempt('s3cret-pw-3')) === 200, '限速窗口过后仍无法登录');
      assert((await attempt('definitely-wrong')) === 401, '成功登录后失败计数未清零');
      return `前 ${AUTH_LOGIN_FAILURE_LIMIT} 次 401 → 429（${limitedMessage}）→ 恢复`;
    });

    process.stdout.write('\n旧库升级：\n');

    await expect('旧库回填 password_changed_at（不再把改过的密码当成出厂密码）', async () => {
      // Rebuild the row the way an older version left it: without
      // `password_changed_at`, without migration 005, and with a real password.
      // `credentialsSummary()` used to answer this question by verifying the
      // factory password on every request.
      ctx.db.exec('ALTER TABLE auth_account DROP COLUMN password_changed_at');
      ctx.db.run('DELETE FROM schema_migrations WHERE id = ?', ['005_auth_password_changed']);
      ctx.db.run(
        `UPDATE auth_account
         SET username = 'admin', password_hash = ?, updated_at = ?
         WHERE id = 'default'`,
        [hashPassword('legacy-pw'), new Date(Date.now() + 1_000).toISOString()],
      );

      migrate(ctx.db);
      ctx.auth.bootstrap();

      const account = ctx.store.getAuthAccount();
      assert(account?.passwordChangedAt !== null, 'password_changed_at 没有回填');
      assert(
        ctx.auth.credentialsSummary().defaultCredentials === false,
        '旧库里改过的密码仍被当成出厂密码',
      );
      return '已回填';
    });
  } finally {
    for (const probe of realtimeProbes) probe.destroy();
    await app.close();
    ctx.dispose();
    rmSync(home, { recursive: true, force: true });
  }

  const failed = checks.filter((check) => !check.ok);
  process.stdout.write(
    `\n结果：${checks.length - failed.length}/${checks.length} 项通过${
      failed.length > 0 ? '，存在失败项' : ' ✅'
    }\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`自检失败：${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
