import type { TaskLogLine } from '@autogit/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';

import { type ConnectionState, EMPTY_LOG_LINES, logStore, realtime } from '../lib/realtime.js';

export function useRealtimeConnection(): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting');
  useEffect(() => realtime.subscribeState(setState), []);
  return state;
}

/** Bridges server events into React Query invalidation + the task log store. */
export function useRealtimeBridge(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    return realtime.subscribe((event) => {
      switch (event.type) {
        case 'task.log':
          logStore.append(event.line.taskId, event.line);
          break;
        case 'task.updated':
          void queryClient.invalidateQueries({ queryKey: ['tasks'] });
          void queryClient.invalidateQueries({ queryKey: ['task', event.task.id] });
          if (event.task.status === 'succeeded' || event.task.status === 'failed') {
            void queryClient.invalidateQueries({ queryKey: ['repository-overview'] });
            void queryClient.invalidateQueries({ queryKey: ['repositories'] });
          }
          break;
        case 'activity':
          void queryClient.invalidateQueries({ queryKey: ['overview'] });
          void queryClient.invalidateQueries({ queryKey: ['activity'] });
          break;
        case 'repository.updated':
          void queryClient.invalidateQueries({ queryKey: ['repositories'] });
          void queryClient.invalidateQueries({ queryKey: ['repository-overview'] });
          break;
        case 'account.updated':
          void queryClient.invalidateQueries({ queryKey: ['accounts'] });
          break;
        case 'orchestrator.tick':
          void queryClient.invalidateQueries({ queryKey: ['overview'] });
          void queryClient.invalidateQueries({ queryKey: ['orchestrator'] });
          break;
        case 'codex.install':
          void queryClient.invalidateQueries({ queryKey: ['codex-install'] });
          if (event.state.running === false && event.state.exitCode !== null) {
            void queryClient.invalidateQueries({ queryKey: ['codex-status'] });
          }
          break;
        case 'notice':
          if (event.level === 'error') toast.error(event.message);
          break;
        default:
          break;
      }
    });
  }, [queryClient]);
}

export function useTaskLogs(taskId: string | null, seed: TaskLogLine[] = []): TaskLogLine[] {
  useEffect(() => {
    if (taskId && seed.length > 0) logStore.seed(taskId, seed);
  }, [taskId, seed]);

  return useSyncExternalStore(
    (listener) => (taskId ? logStore.subscribe(taskId, listener) : () => undefined),
    () => (taskId ? logStore.get(taskId) : EMPTY_LOG_LINES),
  );
}
