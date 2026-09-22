import type { LogStream, TaskLogLine } from '@autogit/shared';
import { Download, ListFilter, ScrollText, Trash, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { useTaskLogs } from '../hooks/useRealtime.js';
import { logStore } from '../lib/realtime.js';
import { cn } from '../lib/utils.js';
import { EmptyState, Spinner } from './primitives.js';

const STREAM_STYLES: Record<LogStream, { label: string; className: string }> = {
  system: { label: 'SYS', className: 'text-slate-500' },
  stdout: { label: 'OUT', className: 'text-slate-300' },
  stderr: { label: 'ERR', className: 'text-rose-300' },
  agent: { label: 'AI', className: 'text-indigo-200' },
  command: { label: 'CMD', className: 'text-cyan-200' },
  git: { label: 'GIT', className: 'text-emerald-200' },
};

const FILTERS: Array<{ id: 'all' | LogStream; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'agent', label: 'AI 输出' },
  { id: 'command', label: '命令' },
  { id: 'git', label: 'Git' },
  { id: 'stderr', label: '错误' },
  { id: 'system', label: '系统' },
];

export function TaskLogViewer({
  taskId,
  seedLines = [],
  height = 'h-[26rem]',
  isRunning = false,
}: {
  taskId: string | null;
  seedLines?: TaskLogLine[];
  height?: string;
  isRunning?: boolean;
}): ReactNode {
  const lines = useTaskLogs(taskId, seedLines);
  const [filter, setFilter] = useState<'all' | LogStream>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => (filter === 'all' ? lines : lines.filter((line) => line.stream === filter)),
    [lines, filter],
  );

  useEffect(() => {
    if (!autoScroll) return;
    const element = containerRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [autoScroll]);

  const download = (): void => {
    const content = filtered
      .map((line) => `[${line.ts}] [${line.stream}] ${line.message}`)
      .join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${taskId ?? 'autogit'}-log.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="panel overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
            <ScrollText className="h-3.5 w-3.5 text-indigo-300" />
            实时日志
          </span>
          {isRunning && (
            <span className="chip border-indigo-400/30 bg-indigo-400/10 text-indigo-200">
              <Spinner className="h-3 w-3" />
              运行中
            </span>
          )}
          <span className="chip text-slate-400">
            <ListFilter className="h-3 w-3" />
            {filtered.length} / {lines.length} 行
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            className="select w-auto py-1 text-[11px]"
            value={filter}
            onChange={(event) => setFilter(event.target.value as 'all' | LogStream)}
          >
            {FILTERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={cn(
              'btn px-2 py-1 text-[11px]',
              autoScroll && 'border-indigo-400/40 text-indigo-200',
            )}
            onClick={() => setAutoScroll((value) => !value)}
          >
            自动滚动 {autoScroll ? '开' : '关'}
          </button>
          <button
            type="button"
            className="btn btn-ghost px-2 py-1 text-[11px]"
            onClick={download}
            disabled={filtered.length === 0}
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="btn btn-ghost px-2 py-1 text-[11px]"
            onClick={() => taskId && logStore.clear(taskId)}
            disabled={!taskId || lines.length === 0}
            title="清空当前视图（不影响服务端记录）"
          >
            <Trash className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>
      <div className="hairline" />
      <div
        ref={containerRef}
        className={cn('scroll-thin overflow-y-auto bg-black/40 px-3 py-2', height)}
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={<X className="h-4 w-4" />}
            title="暂无日志"
            description={taskId ? '任务开始输出后会实时显示在这里。' : '请选择一个任务查看日志。'}
            className="border-none bg-transparent py-8"
          />
        ) : (
          filtered.map((line) => (
            <div key={line.id} className="log-line flex gap-2 py-[1px]">
              <span className="shrink-0 select-none text-[10px] text-slate-600">
                {line.ts.slice(11, 19)}
              </span>
              <span
                className={cn(
                  'shrink-0 select-none text-[10px] font-semibold',
                  STREAM_STYLES[line.stream].className,
                )}
              >
                {STREAM_STYLES[line.stream].label}
              </span>
              <span className={cn('min-w-0 flex-1', STREAM_STYLES[line.stream].className)}>
                {line.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
