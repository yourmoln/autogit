import { AI_LABELS, labelTitle } from '@autogit/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheck,
  GitBranch,
  GitPullRequest,
  Plug,
  RefreshCw,
  Tags,
  Terminal,
  TriangleAlert,
  Workflow,
  Zap,
} from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { LabelChip, ProviderBadge } from '../components/badges.js';
import { EmptyState, SectionCard, Skeleton, StatCard } from '../components/primitives.js';
import { TaskList } from '../components/TaskList.js';
import { api, errorMessage } from '../lib/api.js';
import { cn, formatRelative } from '../lib/utils.js';

export function DashboardPage(): ReactNode {
  const queryClient = useQueryClient();

  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    refetchInterval: 15_000,
  });
  const tasks = useQuery({
    queryKey: ['tasks', { limit: 12 }],
    queryFn: () => api.tasks.list({ limit: 12 }),
    refetchInterval: 15_000,
  });

  const tick = useMutation({
    mutationFn: api.tick,
    onSuccess: () => {
      toast.success('已触发一次轮询');
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const stats = overview.data?.stats;
  const activity = overview.data?.activity ?? [];
  const repositories = overview.data?.repositories ?? [];

  const activeTasks = (tasks.data?.items ?? []).filter(
    (task) => task.status === 'running' || task.status === 'queued',
  );
  const finishedTasks = (tasks.data?.items ?? []).filter(
    (task) => task.status !== 'running' && task.status !== 'queued',
  );

  if (overview.isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {['s1', 's2', 's3', 's4'].map((slot) => (
            <Skeleton key={slot} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'chip',
              overview.data?.orchestrator.running
                ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
                : 'border-white/10 text-slate-400',
            )}
          >
            <span className="pulse-dot text-emerald-300" />
            调度器{overview.data?.orchestrator.running ? '运行中' : '已停止'}
          </span>
          <span className="chip border-white/10 text-slate-400">
            轮询间隔 {overview.data?.orchestrator.pollSeconds}s
          </span>
          <span className="chip border-white/10 text-slate-400">
            并发上限 {overview.data?.orchestrator.maxConcurrent}
          </span>
          <span className="chip border-white/10 text-slate-400">
            单仓库并发 {overview.data?.orchestrator.maxConcurrentPerRepo}
          </span>
          <span className="chip border-white/10 text-slate-400">
            上次轮询 {formatRelative(overview.data?.orchestrator.lastTickAt ?? null)}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => tick.mutate()}
          disabled={tick.isPending}
        >
          <RefreshCw className={cn('h-4 w-4', tick.isPending && 'animate-spin')} />
          立即轮询
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Git 账号"
          value={stats?.accounts ?? 0}
          hint="GitHub / Gitea / Gitee"
          icon={<Plug className="h-5 w-5" />}
          tone="brand"
        />
        <StatCard
          label="托管仓库"
          value={stats?.repositories ?? 0}
          hint={`${stats?.enabledRepositories ?? 0} 个已启用轮询`}
          icon={<GitBranch className="h-5 w-5" />}
        />
        <StatCard
          label="已初始化标签"
          value={stats?.labelsInitialized ?? 0}
          hint={`共 ${AI_LABELS.length} 个 ai/* 标签模板`}
          icon={<Tags className="h-5 w-5" />}
          tone="success"
        />
        <StatCard
          label="跟踪中的 Issue / PR"
          value={`${stats?.trackedIssues ?? 0} / ${stats?.trackedPullRequests ?? 0}`}
          hint={`运行中 ${activeTasks.length} · 排队 ${overview.data?.orchestrator.queuedTaskIds.length ?? 0}`}
          icon={<GitPullRequest className="h-5 w-5" />}
          tone="warning"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <SectionCard
          title="任务队列"
          description="Codex CLI 正在执行或等待执行的任务，按 ai/priority-* 排序"
          actions={
            <Link to="/tasks" className="btn btn-ghost text-[11.5px]">
              查看全部
            </Link>
          }
          bodyClassName="p-0"
        >
          <TaskList
            tasks={[...activeTasks, ...finishedTasks].slice(0, 8)}
            // 总览只预览 8 条，保留自然高度；任务页与仓库工作台用固定高度虚拟列表。
            heightClass={null}
            emptyHint="还没有任务记录。给 Issue 打上 ai/todo 并点击「立即轮询」即可开始。"
          />
        </SectionCard>

        <div className="space-y-4">
          <SectionCard
            title="仓库健康"
            description="轮询状态与标签初始化进度"
            actions={
              <Link to="/repositories" className="btn btn-ghost text-[11.5px]">
                管理
              </Link>
            }
            bodyClassName="space-y-2 px-4 py-3"
          >
            {repositories.length === 0 ? (
              <EmptyState
                icon={<GitBranch className="h-5 w-5" />}
                title="尚未导入仓库"
                description="先在「Git 账号」中添加凭证，然后在「仓库」页面导入目标仓库。"
                action={
                  <Link to="/accounts" className="btn btn-primary text-xs">
                    添加账号
                  </Link>
                }
              />
            ) : (
              repositories.slice(0, 6).map((repository) => (
                <Link
                  key={repository.id}
                  to={`/repositories/${repository.id}`}
                  className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5 transition-colors hover:border-indigo-400/35 hover:bg-indigo-500/6"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[12.5px] text-slate-200">{repository.fullName}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-slate-500">
                      <ProviderBadge provider={repository.provider} />
                      <span>{formatRelative(repository.lastPolledAt)}</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {repository.labelsInitialized ? (
                      <span className="chip border-emerald-400/30 bg-emerald-400/10 text-emerald-200">
                        <CircleCheck className="h-3 w-3" />
                        标签就绪
                      </span>
                    ) : (
                      <span className="chip border-amber-400/30 bg-amber-400/10 text-amber-200">
                        <TriangleAlert className="h-3 w-3" />
                        待初始化
                      </span>
                    )}
                    {repository.enabled ? (
                      <span className="chip border-white/10 text-slate-300">轮询中</span>
                    ) : (
                      <span className="chip border-white/10 text-slate-500">已暂停</span>
                    )}
                  </div>
                </Link>
              ))
            )}
          </SectionCard>

          <SectionCard
            title="实时动态"
            description="轮询、领取任务、创建 PR 与评审结论"
            bodyClassName="px-4 py-3"
          >
            {activity.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">暂无动态</p>
            ) : (
              <ol className="relative space-y-3 pl-4">
                <span className="absolute left-1 top-1.5 bottom-1.5 w-px bg-white/8" />
                {activity.slice(0, 10).map((entry) => (
                  <motion.li
                    key={entry.id}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="relative"
                  >
                    <span
                      className={cn(
                        'absolute -left-3.5 top-1 h-2 w-2 rounded-full ring-4 ring-canvas',
                        entry.level === 'success' && 'bg-emerald-400',
                        entry.level === 'info' && 'bg-indigo-400',
                        entry.level === 'warning' && 'bg-amber-400',
                        entry.level === 'error' && 'bg-rose-400',
                      )}
                    />
                    <p className="text-[11.5px] leading-relaxed text-slate-300">{entry.message}</p>
                    <p className="mt-0.5 text-[10px] text-slate-600">
                      {formatRelative(entry.ts)}
                      {entry.repositoryFullName ? ` · ${entry.repositoryFullName}` : ''}
                    </p>
                  </motion.li>
                ))}
              </ol>
            )}
          </SectionCard>
        </div>
      </div>

      <SectionCard
        title="流水线说明"
        description="AutoGit 只通过标签驱动状态流转，所有 AI 动作都由本机 Codex CLI 执行"
        bodyClassName="grid gap-3 px-4 py-4 lg:grid-cols-3"
      >
        <FlowCard
          icon={<Workflow className="h-4 w-4 text-indigo-300" />}
          title="Issue → 实现"
          steps={[
            { label: 'ai/todo', text: '打上标签后进入构建队列' },
            { label: 'ai/doing', text: 'Codex 在隔离工作区实现并提交' },
            { label: 'ai/in-review', text: '自动创建 PR 并打上 ai/needs-review' },
          ]}
        />
        <FlowCard
          icon={<Zap className="h-4 w-4 text-cyan-300" />}
          title="PR → 评审循环"
          steps={[
            { label: 'ai/needs-review', text: 'Codex 评审 diff 并输出结构化结论' },
            { label: 'ai/needs-fix', text: '按评审意见自动修复并回推分支' },
            { label: 'ai/approved', text: '评审通过，等待人工合并' },
          ]}
        />
        <FlowCard
          icon={<Terminal className="h-4 w-4 text-emerald-300" />}
          title="异常与人工介入"
          steps={[
            { label: 'ai/stuck', text: '失败或卡住时打阻塞标签并留言' },
            { label: 'ai/paused', text: '人工暂停，轮询器跳过该条目' },
            { label: 'ai/verify', text: 'PR 合并后等待人工验证并关闭' },
          ]}
        />
      </SectionCard>
    </div>
  );
}

function FlowCard({
  icon,
  title,
  steps,
}: {
  icon: ReactNode;
  title: string;
  steps: Array<{ label: string; text: string }>;
}): ReactNode {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-3.5">
      <p className="flex items-center gap-2 text-[12.5px] font-semibold text-slate-100">
        {icon}
        {title}
      </p>
      <ul className="mt-2.5 space-y-2">
        {steps.map((step) => (
          <li key={step.label} className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0">
              <LabelChip name={step.label} />
            </span>
            <span className="text-[11px] leading-relaxed text-slate-400">{step.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const DASHBOARD_LABEL_HINT = AI_LABELS.map((label) => labelTitle(label.name));
