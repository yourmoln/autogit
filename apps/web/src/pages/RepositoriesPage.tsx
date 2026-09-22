import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheck,
  ExternalLink,
  GitBranch,
  Plus,
  RefreshCw,
  Tags,
  Trash,
  TriangleAlert,
} from 'lucide-react';
import { motion } from 'motion/react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ProviderBadge } from '../components/badges.js';
import {
  EmptyState,
  Field,
  Modal,
  SectionCard,
  Skeleton,
  Spinner,
} from '../components/primitives.js';
import { api, errorMessage } from '../lib/api.js';
import { cn, formatRelative } from '../lib/utils.js';

export function RepositoriesPage(): ReactNode {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState('');
  const [fullName, setFullName] = useState('');
  const [importing, setImporting] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts.list });
  const repositories = useQuery({
    queryKey: ['repositories'],
    queryFn: api.repositories.list,
    refetchInterval: 30_000,
  });

  const importRepository = useMutation({
    mutationFn: () => api.repositories.import({ accountId, fullName: fullName.trim() }),
    onSuccess: (data) => {
      toast.success(`已导入 ${data.repository.fullName}，记得初始化标签`);
      setFullName('');
      setImporting(false);
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const update = useMutation({
    mutationFn: (input: { id: string; enabled?: boolean }) =>
      api.repositories.update(input.id, { enabled: input.enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const initialize = useMutation({
    mutationFn: (id: string) => api.repositories.initializeLabels(id),
    onSuccess: (data) => {
      const { created, updated, unchanged, failed } = data.result;
      toast.success(
        `标签初始化完成：新建 ${created.length} · 更新 ${updated.length} · 已存在 ${unchanged.length}${failed.length > 0 ? ` · 失败 ${failed.length}` : ''}`,
      );
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: () => setPendingId(null),
  });

  const sync = useMutation({
    mutationFn: (id: string) => api.repositories.sync(id),
    onSuccess: () => {
      toast.success('已完成一次同步');
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.repositories.remove(id),
    onSuccess: () => {
      toast.success('已移除仓库');
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const accountList = accounts.data?.items ?? [];
  const items = repositories.data?.items ?? [];

  return (
    <div className="space-y-4">
      <SectionCard
        title="导入仓库"
        description="用于推送 PR 的 Token 需要仓库写权限；私有仓库请确认 Token 已勾选该仓库。"
        actions={
          <>
            <Link to="/accounts" className="btn text-[11.5px]">
              <GitBranch className="h-3.5 w-3.5" />
              浏览账号下的仓库
            </Link>
            <button type="button" className="btn btn-primary" onClick={() => setImporting(true)}>
              <Plus className="h-4 w-4" />
              手动导入
            </button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <MiniStat label="已导入" value={`${items.length} 个仓库`} />
          <MiniStat
            label="已启用轮询"
            value={`${items.filter((item) => item.enabled).length} 个`}
          />
          <MiniStat
            label="标签已就绪"
            value={`${items.filter((item) => item.labelsInitialized).length} 个`}
          />
        </div>
      </SectionCard>

      {repositories.isLoading ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {['r1', 'r2', 'r3', 'r4'].map((slot) => (
            <Skeleton key={slot} className="h-40" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<GitBranch className="h-5 w-5" />}
          title="还没有导入仓库"
          description="导入后点击「初始化标签」，AutoGit 会在该仓库创建全部 15 个 ai/* 标签。之后给 Issue 打上 ai/todo 即可开始自动化。"
          action={
            <button
              type="button"
              className="btn btn-primary text-xs"
              onClick={() => setImporting(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              导入仓库
            </button>
          }
        />
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {items.map((repository, index) => (
            <motion.article
              key={repository.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.03 }}
              className="panel panel-hover flex flex-col gap-3 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/repositories/${repository.id}`}
                      className="truncate text-[13.5px] font-semibold text-slate-100 hover:text-indigo-200"
                    >
                      {repository.fullName}
                    </Link>
                    <ProviderBadge provider={repository.provider} />
                    {repository.private && (
                      <span className="chip border-amber-400/30 bg-amber-400/10 text-amber-200">
                        私有
                      </span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-1 text-[11px] text-slate-500">
                    {repository.description ?? '（无描述）'}
                  </p>
                </div>
                <a
                  href={repository.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-ghost px-2 py-1"
                  title="打开远端仓库"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400 sm:grid-cols-4">
                <Meta
                  label="默认分支"
                  value={<span className="font-mono">{repository.defaultBranch}</span>}
                />
                <Meta label="跟踪 Issue" value={`${repository.tracked} 条`} />
                <Meta label="跟踪 PR" value={`${repository.pullRequests} 条`} />
                <Meta label="上次轮询" value={formatRelative(repository.lastPolledAt)} />
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  className={cn(
                    'chip',
                    repository.labelsInitialized
                      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
                      : 'border-amber-400/30 bg-amber-400/10 text-amber-200',
                  )}
                >
                  {repository.labelsInitialized ? (
                    <CircleCheck className="h-3 w-3" />
                  ) : (
                    <TriangleAlert className="h-3 w-3" />
                  )}
                  {repository.labelsInitialized ? '标签已初始化' : '标签未初始化'}
                </span>
                <button
                  type="button"
                  className={cn(
                    'chip cursor-pointer',
                    repository.enabled ? 'border-indigo-400/30 text-indigo-200' : 'text-slate-400',
                  )}
                  onClick={() => update.mutate({ id: repository.id, enabled: !repository.enabled })}
                >
                  {repository.enabled ? '轮询已启用' : '轮询已暂停'}
                </button>
                {repository.lastPollError && (
                  <span
                    className="chip border-rose-400/30 bg-rose-400/10 text-rose-200"
                    title={repository.lastPollError}
                  >
                    上次轮询报错
                  </span>
                )}
              </div>

              <div className="mt-auto flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  className="btn flex-1 justify-center py-1 text-[11.5px]"
                  disabled={pendingId === repository.id && initialize.isPending}
                  onClick={() => {
                    setPendingId(repository.id);
                    initialize.mutate(repository.id);
                  }}
                >
                  {pendingId === repository.id && initialize.isPending ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : (
                    <Tags className="h-3.5 w-3.5" />
                  )}
                  初始化标签
                </button>
                <button
                  type="button"
                  className="btn px-2 py-1"
                  title="立即同步一次"
                  onClick={() => sync.mutate(repository.id)}
                  disabled={sync.isPending}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', sync.isPending && 'animate-spin')} />
                </button>
                <Link
                  to={`/repositories/${repository.id}`}
                  className="btn px-2.5 py-1 text-[11.5px]"
                >
                  打开工作台
                </Link>
                <button
                  type="button"
                  className="btn btn-danger px-2 py-1"
                  title="移除仓库"
                  onClick={() => {
                    if (window.confirm(`移除 ${repository.fullName}？本地工作区会保留。`)) {
                      remove.mutate(repository.id);
                    }
                  }}
                >
                  <Trash className="h-3.5 w-3.5" />
                </button>
              </div>
            </motion.article>
          ))}
        </div>
      )}

      <Modal
        open={importing}
        onClose={() => setImporting(false)}
        title="导入仓库"
        description="填写 owner/repo，或先在「Git 账号」页面浏览账号下的仓库列表。"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setImporting(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                importRepository.isPending || accountId === '' || fullName.trim().length < 3
              }
              onClick={() => importRepository.mutate()}
            >
              {importRepository.isPending ? <Spinner /> : <Plus className="h-4 w-4" />}
              导入
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="使用账号">
            <select
              className="select"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              <option value="">请选择账号…</option>
              {accountList.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} · {account.provider}
                </option>
              ))}
            </select>
          </Field>
          <Field label="仓库" hint="owner/repo">
            <input
              className="input font-mono text-xs"
              placeholder="例如 vrcm-team/VRCM"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
            />
          </Field>
          {accountList.length === 0 && (
            <p className="text-[11px] text-amber-300">
              还没有任何账号，请先到「Git 账号」页面添加 Token。
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.02] px-3.5 py-2.5">
      <p className="text-[10.5px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-[13px] font-medium text-slate-200">{value}</p>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-slate-600">{label}</p>
      <p className="mt-0.5 text-slate-300">{value}</p>
    </div>
  );
}
