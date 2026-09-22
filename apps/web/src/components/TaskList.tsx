import type { Task } from '@autogit/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, ListChecks, RotateCcw, Square } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';

import { api, errorMessage } from '../lib/api.js';
import { cn, formatDuration, formatRelative, truncate } from '../lib/utils.js';
import { EngineBadge, PriorityBadge, TaskKindBadge, TaskStatusBadge } from './badges.js';
import { EmptyState } from './primitives.js';

export function TaskList({
  tasks,
  onSelect,
  selectedTaskId,
  emptyHint,
  showRepository = true,
}: {
  tasks: Task[];
  onSelect?: (task: Task) => void;
  selectedTaskId?: string | null;
  emptyHint?: ReactNode;
  showRepository?: boolean;
}): ReactNode {
  const queryClient = useQueryClient();

  const cancel = useMutation({
    mutationFn: (id: string) => api.tasks.cancel(id),
    onSuccess: () => {
      toast.success('已请求取消任务');
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const retry = useMutation({
    mutationFn: (id: string) => api.tasks.retry(id),
    onSuccess: () => {
      toast.success('已重新入队，ai/stuck 标签已移除');
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['repository-overview'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (tasks.length === 0) {
    return (
      <EmptyState
        icon={<ListChecks className="h-5 w-5" />}
        title="暂无任务"
        description={emptyHint ?? '给 Issue 打上 ai/todo 标签，或点击「立即轮询」触发流水线。'}
      />
    );
  }

  return (
    <div className="divide-y divide-white/5">
      {tasks.map((task, index) => (
        <motion.div
          key={task.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: Math.min(index * 0.015, 0.2), duration: 0.22 }}
          className={cn(
            'flex flex-wrap items-center gap-3 px-4 py-3 transition-colors',
            onSelect && 'cursor-pointer hover:bg-white/3',
            selectedTaskId === task.id && 'bg-indigo-500/8',
          )}
          onClick={() => onSelect?.(task)}
        >
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="mt-0.5 flex shrink-0 flex-col items-center gap-1">
              <TaskKindBadge kind={task.kind} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <TaskStatusBadge status={task.status} />
                <PriorityBadge priority={task.priority} />
                <EngineBadge engine={task.engine} />
                {showRepository && (
                  <Link
                    to={`/repositories/${task.repositoryId}`}
                    className="chip border-white/10 text-slate-300 hover:border-indigo-400/40 hover:text-indigo-200"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {task.repositoryFullName}
                  </Link>
                )}
              </div>
              <p className="mt-1 truncate text-[12.5px] text-slate-200">
                {task.issueNumber !== null && (
                  <span className="text-slate-500">#{task.issueNumber} </span>
                )}
                {task.issueTitle ?? truncate(task.summary ?? '（无标题）', 90)}
              </p>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10.5px] text-slate-500">
                <span>入队 {formatRelative(task.queuedAt)}</span>
                {task.startedAt && <span>· 开始 {formatRelative(task.startedAt)}</span>}
                {task.durationMs !== null && <span>· 耗时 {formatDuration(task.durationMs)}</span>}
                {task.branch && <span className="font-mono">· {task.branch}</span>}
              </div>
              {task.error && (
                <p className="mt-1 line-clamp-2 text-[11px] text-rose-300/90">{task.error}</p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-ghost px-2 py-1 text-[11px]"
                onClick={(event) => event.stopPropagation()}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                PR #{task.prNumber}
              </a>
            )}
            {(task.status === 'running' || task.status === 'queued') && (
              <button
                type="button"
                className="btn btn-ghost px-2 py-1 text-[11px]"
                onClick={(event) => {
                  event.stopPropagation();
                  cancel.mutate(task.id);
                }}
                disabled={cancel.isPending}
              >
                <Square className="h-3.5 w-3.5" />
                取消
              </button>
            )}
            {(task.status === 'failed' || task.status === 'cancelled') && (
              <RetryButton task={task} pending={retry.isPending} onRetry={retry.mutate} />
            )}
          </div>
        </motion.div>
      ))}
    </div>
  );
}

/**
 * Retry is a one-shot action: re-running the task consumes the `ai/stuck`
 * label the failure left on the Issue/PR, so the button is only enabled while
 * the server says that label is still there.
 */
function RetryButton({
  task,
  pending,
  onRetry,
}: {
  task: Task;
  pending: boolean;
  onRetry: (id: string) => void;
}): ReactNode {
  const retryable = task.retryable === true;
  return (
    <button
      type="button"
      className="btn btn-ghost px-2 py-1 text-[11px]"
      title={
        retryable
          ? '重新入队执行，并移除 ai/stuck 标签（每个失败只能重试一次）'
          : '目标当前不在 ai/stuck 状态（可能已重试过），无法重试'
      }
      onClick={(event) => {
        event.stopPropagation();
        onRetry(task.id);
      }}
      disabled={!retryable || pending}
    >
      <RotateCcw className="h-3.5 w-3.5" />
      重试
    </button>
  );
}
