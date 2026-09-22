import type { ActivityEntry, CodexInstallState, Task, TaskLogLine, TaskStatus } from './types.js';

export interface TaskUpdatedEvent {
  type: 'task.updated';
  task: Task;
}

export interface TaskLogEvent {
  type: 'task.log';
  line: TaskLogLine;
}

export interface TaskRemovedEvent {
  type: 'task.removed';
  taskId: string;
}

export interface ActivityEvent {
  type: 'activity';
  entry: ActivityEntry;
}

export interface RepositoryEvent {
  type: 'repository.updated';
  repositoryId: string;
}

export interface AccountEvent {
  type: 'account.updated';
  accountId: string;
}

export interface OrchestratorEvent {
  type: 'orchestrator.tick';
  at: string;
  queued: number;
  running: number;
  error: string | null;
}

export interface CodexInstallEvent {
  type: 'codex.install';
  state: CodexInstallState;
}

export interface NoticeEvent {
  type: 'notice';
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export type RealtimeEvent =
  | TaskUpdatedEvent
  | TaskLogEvent
  | TaskRemovedEvent
  | ActivityEvent
  | RepositoryEvent
  | AccountEvent
  | OrchestratorEvent
  | CodexInstallEvent
  | NoticeEvent;

export interface TaskStatusChangedEvent {
  type: 'task.status';
  taskId: string;
  status: TaskStatus;
}
