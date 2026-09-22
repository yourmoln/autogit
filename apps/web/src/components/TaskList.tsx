import type { Task } from '@autogit/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, ListChecks, RotateCcw, Square, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';

import { api, errorMessage } from '../lib/api.js';
import { cn, formatDuration, formatRelative, truncate } from '../lib/utils.js';
import { EngineBadge, PriorityBadge, TaskKindBadge, TaskStatusBadge } from './badges.js';
import { EmptyState } from './primitives.js';
import { VirtualList } from './VirtualList.js';

/**
 * 固定行高（px）：虚拟列表据此推算渲染窗口，行内容超出时裁掉而不是撑高，
 * 这样滚动位置才能直接用「下标 × 行高」换算。
 */
const ROW_HEIGHT = 88;

/** 任务列表默认的固定视口高度。 */
const DEFAULT_HEIGHT_CLASS = 'h-[26rem]';

export function TaskList({
  tasks,
  onSelect,
  selectedTaskId,
  emptyHint,
  showRepository = true,
  heightClass = DEFAULT_HEIGHT_CLASS,
}: {
  tasks: Task[];
  onSelect?: (task: Task) => void;
  selectedTaskId?: string | null;
  emptyHint?: ReactNode;
  showRepository?: boolean;
  /**
   * 固定视口高度类（Tailwind）。默认固定高度 + 虚拟滚动，只渲染可视区内的任务；
   * 传 `null` 表示不限高度、一次性渲染全部行，仅用于总览这类条数很少的预览。
   */
  heightClass?: string | null;
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

  const renderRow = (task: Task): ReactNode => (
    <div
      className={cn(
        'relative flex h-full min-w-0 items-center gap-3 px-4 py-2.5 transition-colors',
        selectedTaskId === task.id && 'bg-indigo-500/8',
      )}
    >
      {/*
        整行可点：覆盖整行的按钮负责鼠标点击与键盘焦点，行内链接/操作按钮再单独
        打开 pointer-events，既保留「点哪都能选中」的手感，也不牺牲可访问性。
      */}
      {onSelect && (
        <button
          type="button"
          aria-label={`查看任务日志：${
            task.issueNumber !== null ? `Issue #${task.issueNumber}` : `PR #${task.prNumber ?? '—'}`
          }`}
          className="absolute inset-0 z-0 cursor-pointer transition-colors hover:bg-white/3 focus-visible:bg-indigo-500/10 focus-visible:outline-none"
          onClick={() => onSelect(task)}
        />
      )}

      <div
        className={cn(
          'relative z-10 flex min-w-0 flex-1 items-center gap-3',
          // 有整行按钮时让点击穿透到按钮；纯预览（总览）保留正常指针行为便于选中文字。
          onSelect && 'pointer-events-none',
        )}
      >
        <div className="shrink-0">
          <TaskKindBadge kind={task.kind} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex h-[22px] min-w-0 items-center gap-1.5 overflow-hidden">
            <TaskStatusBadge status={task.status} />
            <PriorityBadge priority={task.priority} />
            <EngineBadge engine={task.engine} />
            {showRepository && (
              <Link
                to={`/repositories/${task.repositoryId}`}
                className="chip pointer-events-auto min-w-0 border-white/10 text-slate-300 hover:border-indigo-400/40 hover:text-indigo-200"
              >
                <span className="truncate">{task.repositoryFullName}</span>
              </Link>
            )}
            {task.error && (
              <span
                className="chip pointer-events-auto min-w-0 border-rose-400/30 bg-rose-400/10 text-rose-200"
                title={task.error}
              >
                <TriangleAlert className="h-3 w-3 shrink-0" />
                <span className="truncate">{task.error}</span>
              </span>
            )}
          </div>
          <p className="truncate text-[12.5px] leading-4 text-slate-200">
            {task.issueNumber !== null && (
              <span className="text-slate-500">#{task.issueNumber} </span>
            )}
            {task.issueTitle ?? truncate(task.summary ?? '（无标题）', 90)}
          </p>
          <div className="flex min-w-0 items-center gap-2 overflow-hidden text-[10.5px] leading-4 text-slate-500">
            <span className="shrink-0">入队 {formatRelative(task.queuedAt)}</span>
            {task.startedAt && (
              <span className="shrink-0">· 开始 {formatRelative(task.startedAt)}</span>
            )}
            {task.durationMs !== null && (
              <span className="shrink-0">· 耗时 {formatDuration(task.durationMs)}</span>
            )}
            {task.branch && <span className="min-w-0 truncate font-mono">· {task.branch}</span>}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {task.prUrl && (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost pointer-events-auto px-2 py-1 text-[11px]"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              PR #{task.prNumber}
            </a>
          )}
          {(task.status === 'running' || task.status === 'queued') && (
            <button
              type="button"
              className="btn btn-ghost pointer-events-auto px-2 py-1 text-[11px]"
              onClick={() => cancel.mutate(task.id)}
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
      </div>
    </div>
  );

  // 预览型调用方（总览）条数很少，保留自然高度；其余场景一律走固定高度虚拟列表。
  if (heightClass === null) {
    return (
      <div className="divide-y divide-white/5">
        {tasks.map((task) => (
          <div key={task.id}>{renderRow(task)}</div>
        ))}
      </div>
    );
  }

  return (
    <VirtualList
      items={tasks}
      itemHeight={ROW_HEIGHT}
      heightClass={heightClass}
      getKey={(task) => task.id}
      renderItem={(task) => renderRow(task)}
    />
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
      className="btn btn-ghost pointer-events-auto px-2 py-1 text-[11px]"
      title={
        retryable
          ? '重新入队执行，并移除 ai/stuck 标签（每个失败只能重试一次）'
          : '目标当前不在 ai/stuck 状态（可能已重试过），无法重试'
      }
      onClick={() => onRetry(task.id)}
      disabled={!retryable || pending}
    >
      <RotateCcw className="h-3.5 w-3.5" />
      重试
    </button>
  );
}
