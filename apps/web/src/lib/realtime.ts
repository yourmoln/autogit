import type { RealtimeEvent, TaskLogLine } from '@autogit/shared';

type Listener = (event: RealtimeEvent) => void;

export type ConnectionState = 'connecting' | 'online' | 'offline';

class RealtimeClient {
  private readonly listeners = new Set<Listener>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private state: ConnectionState = 'connecting';
  private retry = 0;
  private reconnectTimer: number | null = null;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private connect(): void {
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
    socket.onopen = () => {
      this.retry = 0;
      this.setState('online');
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
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(1000 * 2 ** this.retry, 15_000);
    this.retry += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
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
