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
import { loadRuntimeConfig } from '../config.js';
import { migrate } from '../db/migrations.js';
import {
  AUTH_LOGIN_BACKOFF_MS,
  AUTH_LOGIN_FAILURE_LIMIT,
  AUTH_SESSION_COOKIE,
  hashPassword,
  hashSessionToken,
} from '../services/auth.js';
import { HttpError } from '../util/http.js';
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
      const attempts: Array<{ method: 'GET' | 'POST'; url: string }> = [
        { method: 'GET', url: '/%61pi/system/overview' },
        { method: 'GET', url: '/%61pi/system/activity' },
        { method: 'GET', url: '/%61pi/settings' },
        { method: 'GET', url: '/api/%73ystem/overview' },
        { method: 'POST', url: '/%61pi/orchestrator/restart' },
        { method: 'POST', url: '/%61pi/orchestrator/tick' },
        { method: 'GET', url: '/%61pi/realtime' },
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

    let rotatedToken = '';
    await expect('改凭据后已建立的实时连接被服务端关闭（4401）', async () => {
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
      assert(outcome.code === SESSION_GONE_CLOSE_CODE, `关闭码 ${outcome.code}`);
      return `${SESSION_GONE_CLOSE_CODE} 关闭`;
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
