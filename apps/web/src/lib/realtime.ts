import type { RealtimeEvent, TaskLogLine } from '@autogit/shared';

import { ApiRequestError, api } from './api.js';
import { notifyUnauthorized } from './session-events.js';

type Listener = (event: RealtimeEvent) => void;

export type ConnectionState = 'connecting' | 'online' | 'offline';

/** How long a live socket may go without refreshing its session cookie. */
const SESSION_REFRESH_INTERVAL_MS = 12 * 60 * 60_000;
/** Reconnects are frequent and noisy; only the first one in a window pings. */
const SESSION_REFRESH_MIN_GAP_MS = 5 * 60_000;

class RealtimeClient {
  private readonly listeners = new Set<Listener>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private state: ConnectionState = 'connecting';
  private retry = 0;
  private reconnectTimer: number | null = null;
  private sessionTimer: number | null = null;
  private lastSessionRefresh = 0;
  private socket: WebSocket | null = null;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
    this.scheduleSessionRefresh();
  }

  /** Closes the socket for good; used on logout and when a session expires. */
  stop(): void {
    this.started = false;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sessionTimer !== null) {
      window.clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
    this.retry = 0;
    this.socket?.close();
    this.socket = null;
    this.setState('offline');
  }

  private connect(): void {
    if (!this.started) return;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${window.location.host}/api/realtime`;
    this.setState('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      this.setState('online');
      void this.refreshSessionCookie();
    };
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(String(message.data)) as RealtimeEvent;
        for (const listener of [...this.listeners]) listener(event);
      } catch {
        // ignore malformed frames
      }
    };
    socket.onclose = () => {
      this.setState('offline');
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      socket.close();
    };
  }

  private scheduleReconnect(): void {
    if (!this.started) return;
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(1000 * 2 ** this.retry, 15_000);
    this.retry += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private scheduleSessionRefresh(): void {
    if (this.sessionTimer !== null) return;
    this.sessionTimer = window.setTimeout(() => {
      this.sessionTimer = null;
      void this.refreshSessionCookie();
      if (this.started) this.scheduleSessionRefresh();
    }, SESSION_REFRESH_INTERVAL_MS);
  }

  /**
   * Refreshes the session cookie over plain HTTP.
   *
   * A WebSocket upgrade has no response to carry `Set-Cookie`, and the server's
   * 30s re-check on `/api/realtime` only slides `expires_at` in the database: a
   * tab that lives on the realtime connection alone would keep the session alive
   * server-side while the browser dropped its cookie on day 30. One
   * `GET /api/auth/session` every 12h makes the server's `onSend` hook hand back a
   * fresh `Max-Age`.
   */
  private async refreshSessionCookie(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSessionRefresh < SESSION_REFRESH_MIN_GAP_MS) return;
    this.lastSessionRefresh = now;
    try {
      // `GET /api/auth/session` answers 200 + `authenticated: false` when the
      // cookie is gone, and 401 only on other paths — treat both as "logged out".
      const payload = await api.auth.session();
      if (!payload.authenticated) notifyUnauthorized();
    } catch (error) {
      // The cookie died while the socket was open (revoked elsewhere, or expired):
      // raise the same broadcast a protected request would.
      if (error instanceof ApiRequestError && error.status === 401) notifyUnauthorized();
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of [...this.stateListeners]) listener(state);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.start();
    return () => this.listeners.delete(listener);
  }

  subscribeState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }
}

export const realtime = new RealtimeClient();

/**
 * Keeps task log lines in a small store so the log viewer can render at high
 * frequency without re-rendering the whole page tree.
 */
class LogStore {
  private readonly buffers = new Map<string, TaskLogLine[]>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly maxLines = 4000;

  append(taskId: string, line: TaskLogLine): void {
    const buffer = this.buffers.get(taskId) ?? [];
    const next =
      buffer.length >= this.maxLines
        ? [...buffer.slice(-this.maxLines + 1), line]
        : [...buffer, line];
    this.buffers.set(taskId, next);
    this.notify(taskId);
  }

  seed(taskId: string, lines: TaskLogLine[]): void {
    const current = this.buffers.get(taskId);
    if (current && current.length >= lines.length) return;
    this.buffers.set(taskId, [...lines]);
    this.notify(taskId);
  }

  get(taskId: string): TaskLogLine[] {
    return this.buffers.get(taskId) ?? EMPTY_LOG_LINES;
  }

  clear(taskId: string): void {
    this.buffers.delete(taskId);
    this.notify(taskId);
  }

  subscribe(taskId: string, listener: () => void): () => void {
    const set = this.listeners.get(taskId) ?? new Set();
    set.add(listener);
    this.listeners.set(taskId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(taskId);
    };
  }

  private notify(taskId: string): void {
    for (const listener of [...(this.listeners.get(taskId) ?? [])]) listener();
  }
}

export const EMPTY_LOG_LINES: TaskLogLine[] = [];

export const logStore = new LogStore();
