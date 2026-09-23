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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AuthSessionPayload } from '@autogit/shared';

import { buildServer } from '../app.js';
import { loadRuntimeConfig } from '../config.js';
import { AUTH_SESSION_COOKIE, hashSessionToken } from '../services/auth.js';
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
  } finally {
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
