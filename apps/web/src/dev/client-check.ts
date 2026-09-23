/**
 * Self check for the browser side of the session lifecycle.
 *
 * `lib/api.ts`, `lib/realtime.ts` and `lib/session-events.ts` run in a DOM, so
 * this check drives them through tiny stubs (`window`, `WebSocket`, `fetch`)
 * instead of a browser. It covers the two ways a revoked session used to slip
 * past the console:
 *
 * - `lib/realtime.ts` reconnecting forever after the server closed the socket
 *   with `4401` (logout elsewhere, credential change, expiry) — the tab kept
 *   looking signed in while every reconnect answered `401`;
 * - `lib/api.ts` skipping the unauthorized broadcast for every `/api/auth/*`
 *   401, including the guarded `PUT /api/auth/credentials`, which only answers
 *   `401` when the session cookie is gone.
 *
 * Both have to end in the `autogit:unauthorized` broadcast the auth context
 * listens for (`AuthProvider` then stops the realtime client and drops the
 * session, so the router bounces back to the login page).
 *
 * Usage: pnpm --filter @autogit/web client:check
 */

/** Event name the auth context listens for; mirrored to catch accidental drift. */
const UNAUTHORIZED_EVENT_NAME = 'autogit:unauthorized';

/** Longest delay the realtime client uses between reconnects. */
const MAX_RECONNECT_DELAY_MS = 15_000;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
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

interface StubTimer {
  id: number;
  delayMs: number;
  run: () => void;
  cleared: boolean;
}

const timers: StubTimer[] = [];
let nextTimerId = 1;
let broadcasts = 0;

/**
 * The session refresh is throttled to 5 minutes, so the check moves the clock
 * forward instead of waiting: `Date.now()` is the only time source involved.
 */
const realDateNow = Date.now.bind(Date);
let clockOffsetMs = 0;
Date.now = (): number => realDateNow() + clockOffsetMs;

function advanceClock(minutes: number): void {
  clockOffsetMs += minutes * 60_000;
}

/** Timers the client still has queued, longest delay last. */
function pendingTimers(maxDelayMs = Number.POSITIVE_INFINITY): StubTimer[] {
  return timers.filter((timer) => !timer.cleared && timer.delayMs <= maxDelayMs);
}

/** Timers that would reconnect: the 12h session refresh is not one of them. */
function pendingReconnects(): StubTimer[] {
  return pendingTimers(MAX_RECONNECT_DELAY_MS);
}

function runTimer(timer: StubTimer): void {
  timer.cleared = true;
  timer.run();
}

function resetTimers(): void {
  for (const timer of timers) timer.cleared = true;
  timers.length = 0;
}

/** Current broadcast count; a call keeps TypeScript from narrowing `broadcasts`. */
function unauthorizedCount(): number {
  return broadcasts;
}

/** Minimal `window`: timers, the current URL and the event bus. */
const windowStub = {
  location: { protocol: 'http:', host: '127.0.0.1:4711' },
  setTimeout(handler: () => void, delayMs = 0): number {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.push({ id, delayMs, run: handler, cleared: false });
    return id;
  },
  clearTimeout(id: number): void {
    for (const timer of timers) if (timer.id === id) timer.cleared = true;
  },
  dispatchEvent(event: { type: string }): boolean {
    if (event.type === UNAUTHORIZED_EVENT_NAME) broadcasts += 1;
    return true;
  },
  addEventListener(): void {},
  removeEventListener(): void {},
};

/** Records every socket the client opens and lets the check play its frames. */
class StubWebSocket {
  static readonly instances: StubWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    StubWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = 3;
  }

  /** What the browser delivers when the handshake is accepted. */
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** What the browser delivers when the server closes an established socket. */
  serverClose(code: number): void {
    this.readyState = 3;
    const handler = this.onclose;
    assert(handler, '实时连接没有注册 onclose');
    handler({ code });
  }
}

interface StubRoute {
  status: number;
  payload: unknown;
}

const routes = new Map<string, StubRoute>();
const requested: string[] = [];

const fetchStub = async (input: unknown): Promise<Response> => {
  const url = String(input);
  requested.push(url);
  const route = routes.get(url.split('?')[0] ?? url) ?? {
    status: 401,
    payload: { error: '登录状态已失效，请重新登录' },
  };
  return new Response(JSON.stringify(route.payload), {
    status: route.status,
    headers: { 'content-type': 'application/json' },
  });
};

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = windowStub;
globals.WebSocket = StubWebSocket;
globals.fetch = fetchStub;

/**
 * `process` is a Node global and this package only types the DOM, so it is
 * reached through a cast: the check runs under `tsx`, never in a browser.
 */
const nodeProcess = (globalThis as unknown as { process: { exitCode?: number } }).process;

const { UNAUTHORIZED_EVENT } = await import('../lib/session-events.js');
const { realtime } = await import('../lib/realtime.js');
const { ApiRequestError, api } = await import('../lib/api.js');

/** Waits for the promise chains behind a stubbed request. */
async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 0);
    });
  }
}

/** Runs a request that has to reject with an `ApiRequestError`. */
async function expectApiError(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert(error instanceof ApiRequestError, `抛出的不是 ApiRequestError：${String(error)}`);
    return;
  }
  throw new Error('请求没有按预期失败');
}

/** `true` when the failing request broadcast the unauthorized event. */
async function unauthorizedFrom(run: () => Promise<unknown>): Promise<boolean> {
  const before = unauthorizedCount();
  await expectApiError(run);
  return unauthorizedCount() > before;
}

/** A live session, so `onopen`'s refresh must not look like a revoked one. */
const LIVE_SESSION = {
  authenticated: true,
  session: {
    id: 'stub-session',
    username: 'admin',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    persistent: true,
  },
  credentials: { username: 'admin', defaultCredentials: true, updatedAt: null },
};

/** What the server answers once the cookie is gone. */
const ANONYMOUS_SESSION = { authenticated: false, session: null, credentials: null };

async function main(): Promise<void> {
  assert(
    UNAUTHORIZED_EVENT === UNAUTHORIZED_EVENT_NAME,
    `会话失效事件名变了：${UNAUTHORIZED_EVENT}`,
  );

  console.log('\n实时连接：');

  await expect('断线后先核对会话：已失效即广播（非 4401 关闭码）', async () => {
    realtime.stop();
    resetTimers();
    StubWebSocket.instances.length = 0;
    broadcasts = 0;
    // The session died while the socket was down: reconnecting answers 401, so
    // `onopen` never runs and only this check can notice.
    routes.set('/api/auth/session', { status: 200, payload: ANONYMOUS_SESSION });

    realtime.start();
    const socket = StubWebSocket.instances[0];
    assert(socket, 'start() 没有建立实时连接');
    socket.serverClose(1006);
    await flush();
    assert(unauthorizedCount() === 1, `断线后没有核对会话（广播 ${unauthorizedCount()} 次）`);
    assert(pendingReconnects().length === 1, '普通断开没有安排退避重连');

    realtime.stop();
    return '广播 1 次，仍安排退避重连';
  });

  await expect('收到 4401（会话被吊销）→ 广播失效并停止重连', async () => {
    realtime.stop();
    resetTimers();
    StubWebSocket.instances.length = 0;
    broadcasts = 0;
    advanceClock(6);
    routes.set('/api/auth/session', { status: 200, payload: LIVE_SESSION });

    realtime.start();
    const socket = StubWebSocket.instances[0];
    assert(socket, 'start() 没有建立实时连接');
    assert(socket.url.endsWith('/api/realtime'), `连接地址异常：${socket.url}`);

    socket.serverOpen();
    await flush();
    assert(unauthorizedCount() === 0, '连接建立时的正常会话被误判为失效');
    assert(pendingReconnects().length === 0, '连接建立后安排了多余的重连');

    socket.serverClose(4401);
    assert(unauthorizedCount() === 1, `4401 没有广播会话失效（广播 ${unauthorizedCount()} 次）`);
    assert(pendingReconnects().length === 0, '4401 之后仍然安排了重连');
    for (const timer of pendingTimers()) runTimer(timer);
    await flush();
    assert(StubWebSocket.instances.length === 1, '4401 之后仍然重新建立了连接');

    realtime.stop();
    return '广播 1 次，未重连';
  });

  await expect('普通断开且会话仍有效时不广播，仍退避重连', async () => {
    realtime.stop();
    resetTimers();
    StubWebSocket.instances.length = 0;
    broadcasts = 0;
    advanceClock(6);
    routes.set('/api/auth/session', { status: 200, payload: LIVE_SESSION });

    realtime.start();
    const socket = StubWebSocket.instances[0];
    assert(socket, 'start() 没有建立实时连接');
    socket.serverClose(1006);
    await flush();
    assert(unauthorizedCount() === 0, '普通断开被当成会话失效');
    const reconnects = pendingReconnects();
    assert(reconnects.length === 1, `普通断开没有安排重连（${reconnects.length} 个定时器）`);
    const timer = reconnects[0];
    assert(timer, '没有重连定时器');
    runTimer(timer);
    await flush();
    assert(StubWebSocket.instances.length === 2, '退避后没有重新建立连接');

    realtime.stop();
    return '0 次广播，退避后重连 1 次';
  });

  console.log('\n接口 401：');

  await expect('受保护接口的 401 广播会话失效', async () => {
    broadcasts = 0;
    routes.set('/api/auth/credentials', {
      status: 401,
      payload: { error: '登录状态已失效，请重新登录' },
    });
    routes.set('/api/system/overview', {
      status: 401,
      payload: { error: '登录状态已失效，请重新登录' },
    });

    assert(
      await unauthorizedFrom(() => api.auth.updateCredentials({ currentPassword: 'x' })),
      'PUT /api/auth/credentials 的 401 没有广播会话失效',
    );
    assert(
      await unauthorizedFrom(() => api.overview()),
      'GET /api/system/overview 的 401 没有广播会话失效',
    );
    return `${requested.length} 次请求，广播 2 次`;
  });

  await expect('公开登录接口的 401 不广播（密码错误留在表单上）', async () => {
    broadcasts = 0;
    routes.set('/api/auth/login', { status: 401, payload: { error: '用户名或密码不正确' } });
    routes.set('/api/auth/session', { status: 401, payload: { error: '未登录' } });
    routes.set('/api/auth/logout', { status: 401, payload: { error: '未登录' } });

    assert(
      !(await unauthorizedFrom(() =>
        api.auth.login({ username: 'admin', password: 'wrong', remember: false }),
      )),
      '登录失败的 401 被当成会话失效',
    );
    assert(
      !(await unauthorizedFrom(() => api.auth.session())),
      '公开的会话查询 401 被当成会话失效',
    );
    assert(!(await unauthorizedFrom(() => api.auth.logout())), '公开的退出登录 401 被当成会话失效');
    return '广播 0 次';
  });

  await expect('403 等其它错误不广播', async () => {
    broadcasts = 0;
    routes.set('/api/system/overview', {
      status: 403,
      payload: { error: '跨站来源的写请求已被拒绝' },
    });
    assert(!(await unauthorizedFrom(() => api.overview())), '403 被当成会话失效');
    return '广播 0 次';
  });

  const failed = checks.filter((check) => !check.ok);
  console.log(
    `\n结果：${checks.length - failed.length}/${checks.length} 项通过${
      failed.length > 0 ? '，存在失败项' : ' ✅'
    }`,
  );
  if (failed.length > 0) nodeProcess.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(
    `自检失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  nodeProcess.exitCode = 1;
});
