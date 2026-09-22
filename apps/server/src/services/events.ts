import type { RealtimeEvent } from '@autogit/shared';

type Listener = (event: RealtimeEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: RealtimeEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A broken socket must never break the orchestrator.
      }
    }
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}
