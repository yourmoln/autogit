/**
 * Self check for the browser side of the session lifecycle.
 *
 * `lib/api.ts`, `lib/realtime.ts` and `lib/session-state.ts` are all written
 * for a browser, so this check drives them through tiny stubs (`window`,
 * `WebSocket`, `fetch`) and a real React Query cache instead of a DOM. It
 * covers the ways a revoked session used to slip past the console:
 *
 * - `lib/realtime.ts` reconnecting forever after the server closed the socket
 *   with `4401` (logout, a credential change on another device, expiry) — the tab
 *   kept looking signed in while every reconnect answered `401`;
 * - `lib/realtime.ts` treating `4402` — the close the server sends to the browser
 *   that rotated its *own* credentials — as "signed out", which flashed the login
 *   page in the middle of a successful change;
 * - `lib/api.ts` skipping the unauthorized broadcast for every `/api/auth/*`
 *   401, including the guarded `PUT /api/auth/credentials`, which only answers
 *   `401` when the session cookie is gone.
 * - the console keeping what the previous login left behind after that
 *   broadcast: the task log store is a module-level singleton, so signing back
 *   in and opening the same task used to show up to 4000 lines of the old
 *   session (`LogStore.seed` ignores a shorter seed while a longer buffer is
 *   still in place), and the cached pages of the old session were still there.
 *
 * A revoked session has to end in the `autogit:unauthorized` broadcast the auth
 * context listens for (`AuthProvider` then runs `resetSessionState` and the
 * router bounces back to the login page, without anything the previous login
 * cached surviving into the next one); a local rotation must not, because the
 * session it ends is replaced by the answer to the same request.
 *
 * Usage: pnpm --filter @autogit/web client:check
 */

/** Event name the auth context listens for; mirrored to catch accidental drift. */
const UNAUTHORIZED_EVENT_NAME = 'autogit:unauthorized';

/** Close code the server sends to the browser that rotated its own credentials. */
const SESSION_ROTATED_CLOSE_CODE = 4402;

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

/** Listeners registered through `window.addEventListener`, keyed by event name. */
const windowListeners = new Map<string, Set<() => void>>();

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
  /**
   * Counting the broadcast is not enough: the auth context subscribes to
   * `autogit:unauthorized` through `addEventListener`, so the stub has to hand
   * the event to its listeners the way a browser would. Without that, a check
   * could seed task logs, close the socket with `4401` and still never notice
   * whether the teardown behind the broadcast ran at all.
   */
  dispatchEvent(event: { type: string }): boolean {
    if (event.type === UNAUTHORIZED_EVENT_NAME) broadcasts += 1;
    for (const listener of [...(windowListeners.get(event.type) ?? [])]) listener();
    return true;
  },
  addEventListener(type: string, listener: () => void): void {
    const registered = windowListeners.get(type) ?? new Set<() => void>();
    registered.add(listener);
    windowListeners.set(type, registered);
  },
  removeEventListener(type: string, listener: () => void): void {
    windowListeners.get(type)?.delete(listener);
  },
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
const {
  SESSION_ROTATED_CLOSE_CODE: CLIENT_ROTATED_CLOSE_CODE,
  logStore,
  realtime,
} = await import('../lib/realtime.js');
const { AUTH_SESSION_KEY, registerSessionReset, resetSessionState } = await import(
  '../lib/session-state.js'
);
const { ApiRequestError, api } = await import('../lib/api.js');
/**
 * The auth context, imported for the wiring check at the end of the run. It is a
 * React component, so this check never renders it — an effect would not run
 * outside a browser — it reads the source `tsx` compiles it to instead.
 */
const { AuthProvider } = await import('../lib/auth.js');
const { QueryClient } = await import('@tanstack/react-query');

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

/**
 * A real React Query cache, so the teardown runs against the same object the
 * console uses instead of a hand written stub.
 *
 * `gcTime: Infinity` is what keeps this check from hanging: with the default the
 * cache arms a five minute garbage collection timer for the entries nothing
 * observes, and `tsx` would wait for it before exiting.
 */
function newQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY, retry: false } },
  });
}

/** One line as the server hands it to `logStore`. */
function logLine(taskId: string, message: string) {
  return { id: 1, taskId, ts: new Date().toISOString(), stream: 'stdout' as const, message };
}

async function main(): Promise<void> {
  assert(
    UNAUTHORIZED_EVENT === UNAUTHORIZED_EVENT_NAME,
    `会话失效事件名变了：${UNAUTHORIZED_EVENT}`,
  );
  assert(
    CLIENT_ROTATED_CLOSE_CODE === SESSION_ROTATED_CLOSE_CODE,
    `轮换关闭码变了：${CLIENT_ROTATED_CLOSE_CODE}`,
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

  await expect('收到 4402（本机改凭据）→ 不广播失效，用新会话立即重连', async () => {
    realtime.stop();
    resetTimers();
    StubWebSocket.instances.length = 0;
    broadcasts = 0;
    advanceClock(6);
    routes.set('/api/auth/session', { status: 200, payload: LIVE_SESSION });

    realtime.start();
    const socket = StubWebSocket.instances[0];
    assert(socket, 'start() 没有建立实时连接');
    socket.serverOpen();
    await flush();
    assert(unauthorizedCount() === 0, '连接建立时的正常会话被误判为失效');

    // 改凭据时服务端先关掉发起方的连接，新 Cookie 随后才随 200 响应到达：
    // 这个关闭帧说明「换一个 Cookie 再连」，不是「你被登出了」。
    socket.serverClose(SESSION_ROTATED_CLOSE_CODE);
    assert(unauthorizedCount() === 0, `本机轮换被当成会话失效（广播 ${unauthorizedCount()} 次）`);
    const reconnects = pendingReconnects();
    assert(reconnects.length === 1, `轮换后没有安排重连：${reconnects.length} 个定时器`);
    const timer = reconnects[0];
    assert(timer, '没有重连定时器');
    assert(timer.delayMs <= 1_000, `轮换后的重连被拖慢到 ${timer.delayMs}ms`);
    runTimer(timer);
    await flush();
    assert(StubWebSocket.instances.length === 2, '轮换后没有重新建立连接');

    realtime.stop();
    return '0 次广播，重连 1 次';
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

  console.log('\n会话结束后的清理：');

  await expect('会话失效（4401）清空实时日志、受保护缓存并回到匿名登录态', async () => {
    const queryClient = newQueryClient();
    const unsubscribe = registerSessionReset(queryClient);
    const taskId = 'stub-task-revoked';
    logStore.append(taskId, logLine(taskId, '上一段会话写下的日志'));
    queryClient.setQueryData(['tasks'], [{ id: taskId }]);
    queryClient.setQueryData(AUTH_SESSION_KEY, LIVE_SESSION);
    assert(logStore.get(taskId).length === 1, '前置条件不成立：日志没有进入 logStore');
    // 日志视图靠订阅重渲染，所以除了缓冲变空，还必须收到通知。
    let notified = 0;
    const unsubscribeLogs = logStore.subscribe(taskId, () => {
      notified += 1;
    });

    realtime.stop();
    resetTimers();
    StubWebSocket.instances.length = 0;
    broadcasts = 0;
    advanceClock(6);
    routes.set('/api/auth/session', { status: 200, payload: LIVE_SESSION });

    realtime.start();
    const socket = StubWebSocket.instances[0];
    assert(socket, 'start() 没有建立实时连接');
    socket.serverOpen();
    await flush();
    socket.serverClose(4401);
    await flush();
    assert(unauthorizedCount() === 1, '4401 没有广播会话失效，后面的清理无从谈起');

    assert(
      logStore.get(taskId).length === 0,
      `会话失效后 logStore 还留着 ${logStore.get(taskId).length} 行上一段会话的日志`,
    );
    assert(notified >= 1, '清空日志后没有通知订阅方，已挂载的日志视图不会重渲染');
    assert(
      queryClient.getQueryData(['tasks']) === undefined,
      '会话失效后受保护查询的缓存没有被清掉',
    );
    assert(
      queryClient.getQueryData<{ authenticated?: boolean }>(AUTH_SESSION_KEY)?.authenticated ===
        false,
      '会话失效后缓存里的登录态没有回到匿名',
    );

    realtime.stop();
    resetTimers();
    unsubscribeLogs();
    unsubscribe();
    return `广播 1 次，日志 0 行（通知订阅方 ${notified} 次），受保护缓存已移除，登录态已匿名`;
  });

  await expect('登出走同一条清理路径', async () => {
    const queryClient = newQueryClient();
    const taskId = 'stub-task-logout';
    logStore.append(taskId, logLine(taskId, '登出前的日志'));
    queryClient.setQueryData(['task', taskId], { id: taskId });
    queryClient.setQueryData(AUTH_SESSION_KEY, LIVE_SESSION);

    await resetSessionState(queryClient);

    assert(
      logStore.get(taskId).length === 0,
      `登出后 logStore 还留着 ${logStore.get(taskId).length} 行日志`,
    );
    assert(queryClient.getQueryData(['task', taskId]) === undefined, '登出后任务缓存没有被清掉');
    assert(
      queryClient.getQueryData<{ authenticated?: boolean }>(AUTH_SESSION_KEY)?.authenticated ===
        false,
      '登出后缓存里的登录态没有回到匿名',
    );
    return '日志 0 行，任务缓存已移除，登录态已匿名';
  });

  await expect('AuthProvider 把两条路径都接到同一处清理', async () => {
    // 组件本身没法在这里渲染（useEffect 在浏览器之外不会跑），所以核对它编译后
    // 的源码：任何一处漏接线，上面两条断言都测不到，清理入口就会退回死代码。
    const source = AuthProvider.toString();
    assert(
      source.includes('registerSessionReset'),
      'AuthProvider 没有把会话失效广播接到 registerSessionReset',
    );
    assert(
      source.includes('resetSessionState'),
      'AuthProvider 的 logout 没有调用 resetSessionState',
    );
    return '会话失效广播与 logout 都调用 lib/session-state.ts 的清理入口';
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
