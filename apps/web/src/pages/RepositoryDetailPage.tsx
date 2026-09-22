import { PROVIDER_META, type Task } from '@autogit/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ExternalLink,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Tags,
  Terminal,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ProviderBadge } from '../components/badges.js';
import { PipelineBoard, type PipelineColumn } from '../components/PipelineBoard.js';
import {
  CodeBlock,
  EmptyState,
  Modal,
  SectionCard,
  Skeleton,
  Spinner,
  StatCard,
  Toggle,
} from '../components/primitives.js';
import { RepositoryLabelsPanel } from '../components/RepositoryLabelsPanel.js';
import { TaskList } from '../components/TaskList.js';
import { TaskLogViewer } from '../components/TaskLogViewer.js';
import { api, errorMessage } from '../lib/api.js';
import { cn, formatRelative } from '../lib/utils.js';

export function RepositoryDetailPage(): ReactNode {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showPrompts, setShowPrompts] = useState(false);
  const [promptKind, setPromptKind] = useState<'implement' | 'review' | 'fix'>('implement');
  const [promptTarget, setPromptTarget] = useState('');

  const overviewQuery = useQuery({
    queryKey: ['repository-overview', id],
    queryFn: () => api.repositories.overview(id),
    enabled: id !== '',
    refetchInterval: 12_000,
  });

  const labelPreview = useQuery({
    queryKey: ['label-preview', id],
    queryFn: () => api.repositories.labelPreview(id),
    enabled: id !== '',
    staleTime: 30_000,
  });

  const refreshAll = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['repository-overview', id] });
    void queryClient.invalidateQueries({ queryKey: ['label-preview', id] });
    void queryClient.invalidateQueries({ queryKey: ['repositories'] });
  };

  const initialize = useMutation({
    mutationFn: () => api.repositories.initializeLabels(id),
    onSuccess: (data) => {
      const { created, updated, unchanged, failed } = data.result;
      toast.success(
        `标签同步完成：新建 ${created.length} · 更新 ${updated.length} · 已存在 ${unchanged.length}${failed.length > 0 ? ` · 失败 ${failed.length}` : ''}`,
      );
      refreshAll();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const sync = useMutation({
    mutationFn: () => api.repositories.sync(id),
    onSuccess: () => {
      toast.success('已同步远端状态');
      refreshAll();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) => api.repositories.update(id, { enabled }),
    onSuccess: () => refreshAll(),
    onError: (error) => toast.error(errorMessage(error)),
  });

  const runTask = useMutation({
    mutationFn: (input: {
      kind: 'implement' | 'review' | 'fix';
      issueNumber?: number;
      prNumber?: number;
    }) => api.repositories.runTask(id, input),
    onSuccess: (data) => {
      const label =
        data.task.kind === 'implement' ? '实现' : data.task.kind === 'review' ? '评审' : '修复';
      toast.success(`已创建${label}任务，稍后可在任务页查看日志`);
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      refreshAll();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const prompt = useQuery({
    queryKey: ['prompt-preview', id, promptKind, promptTarget],
    queryFn: () =>
      api.codex.promptPreview({
        repositoryId: id,
        kind: promptKind,
        issueNumber: promptKind === 'implement' ? Number(promptTarget) : undefined,
        prNumber: promptKind === 'implement' ? undefined : Number(promptTarget),
      }),
    enabled: showPrompts && promptTarget.trim().length > 0,
  });

  if (overviewQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-44" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  if (overviewQuery.isError || !overviewQuery.data) {
    return (
      <EmptyState
        icon={<TriangleAlert className="h-5 w-5" />}
        title="无法打开该仓库"
        description={errorMessage(overviewQuery.error)}
        action={
          <Link to="/repositories" className="btn text-xs">
            返回仓库列表
          </Link>
        }
      />
    );
  }

  const { repository, counts, issues, pullRequests, tasks } = overviewQuery.data;

  const issueColumns: PipelineColumn[] = [
    {
      label: 'ai/todo',
      title: '待实现',
      items: issues.filter((issue) => issue.labels.includes('ai/todo')),
      action: {
        label: '立即实现',
        icon: <Play className="h-3.5 w-3.5" />,
        disabled: runTask.isPending,
        onClick: (item) => runTask.mutate({ kind: 'implement', issueNumber: item.number }),
      },
    },
    {
      label: 'ai/doing',
      title: '实现中',
      items: issues.filter((issue) => issue.labels.includes('ai/doing')),
    },
    {
      label: 'ai/in-review',
      title: '评审 / 修复',
      items: issues.filter((issue) => issue.labels.includes('ai/in-review')),
    },
    {
      label: 'ai/verify',
      title: '待人工验证',
      items: issues.filter((issue) => issue.labels.includes('ai/verify')),
      action: {
        label: '打开 Issue',
        icon: <ExternalLink className="h-3.5 w-3.5" />,
        onClick: (item) => window.open(item.htmlUrl, '_blank', 'noreferrer'),
      },
    },
  ];

  const pullColumns: PipelineColumn[] = [
    {
      label: 'ai/needs-review',
      title: '待 AI 评审',
      items: pullRequests.filter((pr) => pr.labels.includes('ai/needs-review')),
      action: {
        label: '立即评审',
        icon: <Search className="h-3.5 w-3.5" />,
        disabled: runTask.isPending,
        onClick: (item) => runTask.mutate({ kind: 'review', prNumber: item.number }),
      },
    },
    {
      label: 'ai/needs-fix',
      title: '待修复',
      items: pullRequests.filter((pr) => pr.labels.includes('ai/needs-fix')),
      action: {
        label: '立即修复',
        icon: <RotateCcw className="h-3.5 w-3.5" />,
        disabled: runTask.isPending,
        onClick: (item) => runTask.mutate({ kind: 'fix', prNumber: item.number }),
      },
    },
    {
      label: 'ai/approved',
      title: '评审通过',
      items: pullRequests.filter((pr) => pr.labels.includes('ai/approved')),
      action: {
        label: '打开 PR 并合并',
        icon: <ExternalLink className="h-3.5 w-3.5" />,
        onClick: (item) => window.open(item.htmlUrl, '_blank', 'noreferrer'),
      },
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/repositories" className="btn btn-ghost px-2 py-1 text-[11.5px]">
          <ArrowLeft className="h-3.5 w-3.5" />
          仓库列表
        </Link>
        <span className="text-[11px] text-slate-600">/</span>
        <span className="text-[11.5px] text-slate-400">{repository.fullName}</span>
        <span className="chip border-white/10 text-slate-500">
          {PROVIDER_META[repository.provider].label}
        </span>
      </div>

      <SectionCard
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold text-slate-100">{repository.fullName}</span>
            <ProviderBadge provider={repository.provider} />
            {repository.private && (
              <span className="chip border-amber-400/30 bg-amber-400/10 text-amber-200">私有</span>
            )}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2 text-[11px]">
            <span>默认分支 {repository.defaultBranch}</span>
            <span>· 上次轮询 {formatRelative(repository.lastPolledAt)}</span>
            <span>· 标签同步 {formatRelative(repository.labelSyncedAt)}</span>
            {repository.lastPollError && (
              <span className="text-rose-300">· {repository.lastPollError}</span>
            )}
          </span>
        }
        actions={
          <>
            <a
              href={repository.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="btn text-[11.5px]"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              远端仓库
            </a>
            <button
              type="button"
              className="btn text-[11.5px]"
              onClick={() => setShowPrompts(true)}
            >
              <Terminal className="h-3.5 w-3.5" />
              提示词预览
            </button>
            <button
              type="button"
              className="btn text-[11.5px]"
              onClick={() => sync.mutate()}
              disabled={sync.isPending}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', sync.isPending && 'animate-spin')} />
              立即同步
            </button>
            <button
              type="button"
              className="btn btn-primary text-[11.5px]"
              onClick={() => initialize.mutate()}
              disabled={initialize.isPending}
            >
              {initialize.isPending ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Tags className="h-3.5 w-3.5" />
              )}
              初始化 / 同步标签
            </button>
          </>
        }
        bodyClassName="space-y-4"
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="待实现" value={counts.todo} hint="ai/todo" tone="brand" />
          <StatCard label="实现中" value={counts.doing} hint="ai/doing" tone="brand" />
          <StatCard
            label="待 AI 评审"
            value={counts.needsReview}
            hint="ai/needs-review"
            tone="warning"
          />
          <StatCard
            label="已通过待合并"
            value={counts.approved}
            hint="ai/approved"
            tone="success"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Issue 评审中"
            value={counts.inReview}
            hint="ai/in-review"
            tone="warning"
          />
          <StatCard label="待修复" value={counts.needsFix} hint="ai/needs-fix" tone="warning" />
          <StatCard label="待人工验证" value={counts.verify} hint="ai/verify" tone="success" />
          <StatCard
            label="阻塞 / 暂停"
            value={`${counts.stuck} / ${counts.paused}`}
            hint="ai/stuck · ai/paused"
            tone="danger"
          />
        </div>
        <Toggle
          checked={repository.enabled}
          onChange={(value) => setEnabled.mutate(value)}
          label="启用自动轮询"
          description="关闭后 AutoGit 不再扫描该仓库的新标签变化，已排队任务仍会执行完毕。"
        />
      </SectionCard>

      <SectionCard
        title="Issue 流水线"
        description="Issue 状态标签：ai/todo → ai/doing → ai/in-review → ai/verify"
        bodyClassName="px-4 py-4"
      >
        <PipelineBoard columns={issueColumns} emptyLabel="没有处于该状态的 Issue" />
      </SectionCard>

      <SectionCard
        title="Pull Request 评审回路"
        description="PR 状态标签：ai/needs-review →（ai/approved 或 ai/needs-fix）"
        bodyClassName="px-4 py-4"
      >
        <PipelineBoard columns={pullColumns} emptyLabel="没有处于该状态的 PR" />
      </SectionCard>

      <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr]">
        <SectionCard
          title="任务记录"
          description="该仓库最近 30 条任务，点击查看实时日志"
          bodyClassName="p-0"
        >
          <TaskList
            tasks={tasks}
            selectedTaskId={selectedTask?.id ?? null}
            onSelect={setSelectedTask}
            showRepository={false}
            heightClass="h-[26rem]"
            emptyHint="该仓库还没有任务记录。"
          />
        </SectionCard>

        <div className="space-y-4">
          <RepositoryLabelsPanel
            labels={labelPreview.data?.labels}
            loading={labelPreview.isLoading}
          />
          {selectedTask ? (
            <TaskLogViewer
              taskId={selectedTask.id}
              isRunning={selectedTask.status === 'running'}
              height="h-[24rem]"
            />
          ) : (
            <EmptyState
              icon={<Terminal className="h-5 w-5" />}
              title="选择任务查看日志"
              description="左侧任意一条任务都可以打开实时日志流。"
            />
          )}
        </div>
      </div>

      <Modal
        open={showPrompts}
        onClose={() => setShowPrompts(false)}
        width="max-w-4xl"
        title="提示词预览"
        description="展示 AutoGit 实际发送给 Codex CLI 的指令，便于审查与调试。预览不会触发执行。"
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="select w-auto"
              value={promptKind}
              onChange={(event) => {
                setPromptKind(event.target.value as 'implement' | 'review' | 'fix');
                setPromptTarget('');
              }}
            >
              <option value="implement">实现（Issue）</option>
              <option value="review">评审（PR）</option>
              <option value="fix">修复（PR）</option>
            </select>
            <input
              className="input w-40"
              placeholder={promptKind === 'implement' ? 'Issue 编号' : 'PR 编号'}
              value={promptTarget}
              onChange={(event) => setPromptTarget(event.target.value.replace(/[^0-9]/g, ''))}
            />
            {prompt.isFetching && <Spinner />}
          </div>
          {prompt.data ? (
            <CodeBlock code={prompt.data.prompt} maxHeight="max-h-[58vh]" />
          ) : (
            <EmptyState
              icon={<Terminal className="h-5 w-5" />}
              title="输入编号后生成预览"
              description="例如 Issue 编号 12 或 PR 编号 34。"
            />
          )}
          {prompt.isError && (
            <p className="text-[11px] text-rose-300">{errorMessage(prompt.error)}</p>
          )}
        </div>
      </Modal>
    </div>
  );
}
