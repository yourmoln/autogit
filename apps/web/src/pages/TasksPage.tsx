import type { Task, TaskStatus } from '@autogit/shared';
import { useQuery } from '@tanstack/react-query';
import { ListFilter, RefreshCw, Terminal } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, SectionCard, StatCard, Toggle } from '../components/primitives.js';
import { TaskList } from '../components/TaskList.js';
import { TaskLogViewer } from '../components/TaskLogViewer.js';
import { api } from '../lib/api.js';
import { cn } from '../lib/utils.js';

const STATUS_OPTIONS: Array<{ value: 'all' | TaskStatus; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'running', label: '运行中' },
  { value: 'queued', label: '排队中' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
];

export function TasksPage(): ReactNode {
  const [repositoryId, setRepositoryId] = useState('');
  const [status, setStatus] = useState<'all' | TaskStatus>('all');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selected, setSelected] = useState<Task | null>(null);

  const repositories = useQuery({ queryKey: ['repositories'], queryFn: api.repositories.list });
  const tasks = useQuery({
    queryKey: ['tasks', { repositoryId, status }],
    queryFn: () =>
      api.tasks.list({
        repositoryId: repositoryId || undefined,
        status: status === 'all' ? undefined : status,
        limit: 150,
      }),
    refetchInterval: autoRefresh ? 8_000 : false,
  });

  const detail = useQuery({
    queryKey: ['task', selected?.id],
    queryFn: () => api.tasks.detail(selected?.id ?? ''),
    enabled: selected !== null,
  });

  useEffect(() => {
    if (detail.data?.task)
      setSelected((current) => (current?.id === detail.data?.task.id ? detail.data.task : current));
  }, [detail.data?.task]);

  const items = tasks.data?.items ?? [];
  const counts = tasks.data?.counts ?? {};
  const _running = items.filter((task) => task.status === 'running').length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="运行中" value={counts.running ?? 0} hint="Codex 正在执行" tone="brand" />
        <StatCard label="排队中" value={counts.queued ?? 0} hint="等待空闲槽位" tone="warning" />
        <StatCard
          label="累计成功"
          value={counts.succeeded ?? 0}
          hint="含实现 / 评审 / 修复"
          tone="success"
        />
        <StatCard
          label="累计失败"
          value={counts.failed ?? 0}
          hint="失败会自动打 ai/stuck"
          tone="danger"
        />
      </div>

      <SectionCard
        title="任务队列"
        description="Codex CLI 执行记录；点击任意任务查看逐行实时日志"
        actions={
          <>
            <select
              className="select w-auto py-1 text-[11.5px]"
              value={repositoryId}
              onChange={(event) => setRepositoryId(event.target.value)}
            >
              <option value="">全部仓库</option>
              {repositories.data?.items.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.fullName}
                </option>
              ))}
            </select>
            <select
              className="select w-auto py-1 text-[11.5px]"
              value={status}
              onChange={(event) => setStatus(event.target.value as 'all' | TaskStatus)}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn px-2 py-1 text-[11.5px]"
              onClick={() => {
                void tasks.refetch();
                toast.success('已刷新任务列表');
              }}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', tasks.isFetching && 'animate-spin')} />
            </button>
          </>
        }
        bodyClassName="p-0"
      >
        <div className="border-b border-white/5 px-4 py-2.5">
          <Toggle
            checked={autoRefresh}
            onChange={setAutoRefresh}
            label="自动刷新（8s）"
            description="实时日志始终通过 WebSocket 推送，此处仅控制列表刷新。"
          />
        </div>
        <TaskList
          tasks={items}
          onSelect={setSelected}
          selectedTaskId={selected?.id ?? null}
          heightClass="h-[30rem]"
        />
      </SectionCard>

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <SectionCard
          title={selected ? `日志 · ${selected.repositoryFullName}` : '实时日志'}
          description={
            selected
              ? `${selected.kind} · ${
                  selected.issueNumber !== null
                    ? `#${selected.issueNumber}`
                    : `PR #${selected.prNumber}`
                } · ${selected.status}`
              : '从上方任务列表中选择一条任务'
          }
          bodyClassName="p-0"
        >
          <TaskLogViewer
            taskId={selected?.id ?? null}
            seedLines={detail.data?.logs ?? []}
            isRunning={selected?.status === 'running'}
            height="h-[32rem]"
          />
        </SectionCard>

        <SectionCard title="任务详情" description="执行上下文与结果摘要" bodyClassName="space-y-3">
          {selected ? (
            <div className="space-y-3 text-[11.5px]">
              <DetailRow label="任务 ID" value={<span className="font-mono">{selected.id}</span>} />
              <DetailRow
                label="目标"
                value={
                  selected.issueNumber !== null
                    ? `Issue #${selected.issueNumber}`
                    : `PR #${selected.prNumber ?? '—'}`
                }
              />
              <DetailRow
                label="引擎"
                value={selected.engine === 'claude' ? 'Claude CLI' : 'Codex CLI'}
              />
              <DetailRow
                label="分支"
                value={<span className="font-mono">{selected.branch ?? '—'}</span>}
              />
              <DetailRow
                label="工作区"
                value={
                  <span className="break-all font-mono text-[10.5px]">
                    {selected.workspace ?? '—'}
                  </span>
                }
              />
              <DetailRow label="重试次数" value={selected.attempts} />
              {selected.summary && (
                <div className="rounded-xl border border-white/8 bg-black/30 p-3">
                  <p className="mb-1 text-[10.5px] uppercase tracking-wide text-slate-500">
                    结果摘要
                  </p>
                  <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-slate-300">
                    {selected.summary}
                  </p>
                </div>
              )}
              {selected.error && (
                <div className="rounded-xl border border-rose-500/25 bg-rose-500/8 p-3">
                  <p className="mb-1 text-[10.5px] uppercase tracking-wide text-rose-300/80">
                    错误
                  </p>
                  <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-rose-200">
                    {selected.error}
                  </p>
                </div>
              )}
              {selected.prUrl && (
                <a
                  href={selected.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn w-full justify-center"
                >
                  打开 PR #{selected.prNumber}
                </a>
              )}
            </div>
          ) : (
            <EmptyState
              icon={<ListFilter className="h-5 w-5" />}
              title="尚未选择任务"
              description="选择任务后可查看分支、工作区、结果摘要与错误详情。"
            />
          )}
        </SectionCard>
      </div>

      {items.length === 0 && (
        <EmptyState
          icon={<Terminal className="h-5 w-5" />}
          title="还没有任务"
          description="当 Issue 被打上 ai/todo（或 PR 打上 ai/needs-review）后，调度器会自动创建任务。"
        />
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-white/5 pb-2 last:border-0">
      <span className="text-[10.5px] uppercase tracking-wide text-slate-500">{label}</span>
      <span className="max-w-[68%] text-right text-slate-300">{value}</span>
    </div>
  );
}
