import {
  type Account,
  PROVIDER_META,
  type ProviderKind,
  type RemoteRepositorySummary,
} from '@autogit/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheck,
  ExternalLink,
  GitBranch,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
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
  InfoRow,
  Modal,
  SectionCard,
  Skeleton,
  Spinner,
  Toggle,
} from '../components/primitives.js';
import { api, errorMessage } from '../lib/api.js';
import { cn, formatRelative } from '../lib/utils.js';

interface FormState {
  name: string;
  provider: ProviderKind;
  baseUrl: string;
  token: string;
  verify: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  provider: 'github',
  baseUrl: '',
  token: '',
  verify: true,
};

export function AccountsPage(): ReactNode {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [browsing, setBrowsing] = useState<Account | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts.list });

  const create = useMutation({
    mutationFn: () =>
      api.accounts.create({
        name: form.name.trim(),
        provider: form.provider,
        baseUrl: form.baseUrl.trim() || undefined,
        token: form.token.trim(),
        verify: form.verify,
      }),
    onSuccess: () => {
      toast.success('账号已添加');
      setCreating(false);
      setForm(EMPTY_FORM);
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const update = useMutation({
    mutationFn: () =>
      api.accounts.update(editing?.id ?? '', {
        name: form.name.trim() || undefined,
        baseUrl: form.baseUrl.trim() || undefined,
        token: form.token.trim() || undefined,
        verify: form.verify,
      }),
    onSuccess: () => {
      toast.success('账号已更新');
      setEditing(null);
      setForm(EMPTY_FORM);
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.accounts.remove(id),
    onSuccess: () => {
      toast.success('账号已删除');
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const test = useMutation({
    mutationFn: (id: string) => api.accounts.test(id),
    onSuccess: (result) => {
      if (result.ok) toast.success(`连接成功：@${result.user?.login ?? 'unknown'}`);
      else toast.error(`连接失败：${result.error ?? '未知错误'}`);
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const isSaving = create.isPending || update.isPending;
  const meta = PROVIDER_META[form.provider];

  return (
    <div className="space-y-4">
      <SectionCard
        title="Git 账号"
        description="支持 GitHub、Gitea / Forgejo（自建实例填实例地址）以及 Gitee。Token 会使用 AES-256-GCM 加密后存入本地 SQLite。"
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setForm(EMPTY_FORM);
              setCreating(true);
            }}
          >
            <Plus className="h-4 w-4" />
            添加账号
          </button>
        }
        bodyClassName="p-0"
      >
        {accounts.isLoading ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        ) : (accounts.data?.items.length ?? 0) === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<Plug className="h-5 w-5" />}
              title="还没有配置任何 Git 账号"
              description="添加一个 Personal Access Token 后，就可以浏览该账号下的仓库并导入 AutoGit。"
              action={
                <button
                  type="button"
                  className="btn btn-primary text-xs"
                  onClick={() => setCreating(true)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加第一个账号
                </button>
              }
            />
          </div>
        ) : (
          <div className="grid gap-3 p-4 lg:grid-cols-2 2xl:grid-cols-3">
            {accounts.data?.items.map((account, index) => (
              <motion.article
                key={account.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.03 }}
                className="panel panel-hover flex flex-col gap-3 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    {account.avatarUrl ? (
                      <img
                        src={account.avatarUrl}
                        alt=""
                        className="h-10 w-10 rounded-xl border border-white/10 object-cover"
                      />
                    ) : (
                      <span className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/5">
                        <KeyRound className="h-4 w-4 text-slate-400" />
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-slate-100">
                        {account.name}
                      </p>
                      <p className="truncate text-[11px] text-slate-500">
                        {account.username ? `@${account.username}` : '未验证身份'}
                      </p>
                    </div>
                  </div>
                  <ProviderBadge provider={account.provider} />
                </div>

                <div className="space-y-0">
                  <InfoRow
                    label="API"
                    value={<span className="font-mono text-[10.5px]">{account.baseUrl}</span>}
                  />
                  <InfoRow
                    label="Token"
                    value={<span className="font-mono">{account.tokenPreview ?? '—'}</span>}
                  />
                  <InfoRow label="仓库" value={`${account.repositoryCount} 个已导入`} />
                  <InfoRow label="最近校验" value={formatRelative(account.lastCheckedAt)} />
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={cn(
                      'chip',
                      account.status === 'ok'
                        ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
                        : account.status === 'error'
                          ? 'border-rose-400/30 bg-rose-400/10 text-rose-200'
                          : 'border-white/10 text-slate-400',
                    )}
                  >
                    {account.status === 'ok' ? (
                      <CircleCheck className="h-3 w-3" />
                    ) : (
                      <TriangleAlert className="h-3 w-3" />
                    )}
                    {account.statusMessage ?? '未校验'}
                  </span>
                </div>

                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className="btn flex-1 justify-center py-1 text-[11.5px]"
                    onClick={() => setBrowsing(account)}
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                    浏览仓库
                  </button>
                  <button
                    type="button"
                    className="btn px-2 py-1"
                    onClick={() => test.mutate(account.id)}
                    disabled={test.isPending}
                    title="测试连接"
                  >
                    {test.isPending ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn px-2 py-1"
                    onClick={() => {
                      setEditing(account);
                      setForm({
                        name: account.name,
                        provider: account.provider,
                        baseUrl: account.baseUrl,
                        token: '',
                        verify: true,
                      });
                    }}
                    title="编辑"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger px-2 py-1"
                    title="删除账号"
                    onClick={() => {
                      if (
                        window.confirm(
                          `删除账号「${account.name}」？其下 ${account.repositoryCount} 个仓库配置也会一并移除。`,
                        )
                      ) {
                        remove.mutate(account.id);
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
      </SectionCard>

      <SectionCard
        title="如何获取 Token"
        description="不同平台的最小权限要求"
        bodyClassName="grid gap-3 px-4 py-4 md:grid-cols-3"
      >
        {(Object.keys(PROVIDER_META) as ProviderKind[]).map((provider) => (
          <div
            key={provider}
            className="rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-3"
          >
            <div className="flex items-center justify-between gap-2">
              <ProviderBadge provider={provider} />
              <a
                href={PROVIDER_META[provider].tokenHelpUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-ghost px-2 py-1 text-[11px]"
              >
                <ExternalLink className="h-3 w-3" />
                生成
              </a>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
              {provider === 'github'
                ? '权限：repo（读写代码与 PR）、issues（读写 Issue 与标签）。企业版请把 API 地址改为 https://git.example.com/api/v3。'
                : provider === 'gitea'
                  ? '权限：repository 读写 + issue 读写。实例地址填 https://git.example.com（AutoGit 会自动补 /api/v1）。'
                  : '权限：projects、pull_requests、issues。私有仓库需要勾选对应私有项目权限。'}
            </p>
          </div>
        ))}
      </SectionCard>

      <Modal
        open={creating || editing !== null}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        title={editing ? `编辑账号：${editing.name}` : '添加 Git 账号'}
        description="Token 只保存在本机，前端永远不会读取明文。"
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setCreating(false);
                setEditing(null);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                isSaving ||
                form.name.trim().length === 0 ||
                (!editing && form.token.trim().length < 8)
              }
              onClick={() => (editing ? update.mutate() : create.mutate())}
            >
              {isSaving ? <Spinner /> : <Plus className="h-4 w-4" />}
              {editing ? '保存修改' : '创建账号'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="账号名称" hint="仅用于本地区分">
            <input
              className="input"
              value={form.name}
              placeholder="例如：公司 Gitea / 我的 GitHub"
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>

          <Field label="平台" hint={meta.requiresBaseUrl ? '需要实例地址' : '可使用默认 API 地址'}>
            <select
              className="select"
              value={form.provider}
              disabled={editing !== null}
              onChange={(event) => {
                const provider = event.target.value as ProviderKind;
                setForm({
                  ...form,
                  provider,
                  baseUrl: PROVIDER_META[provider].defaultBaseUrl ?? '',
                });
              }}
            >
              {(Object.keys(PROVIDER_META) as ProviderKind[]).map((provider) => (
                <option key={provider} value={provider}>
                  {PROVIDER_META[provider].label}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="API / 实例地址"
            hint={
              meta.defaultBaseUrl ? `默认 ${meta.defaultBaseUrl}` : '例如 https://git.example.com'
            }
          >
            <input
              className="input font-mono text-xs"
              value={form.baseUrl}
              placeholder={meta.defaultBaseUrl ?? 'https://git.example.com'}
              onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
            />
          </Field>

          <Field label="Personal Access Token" hint={editing ? '留空表示不修改' : '必填'}>
            <input
              className="input font-mono text-xs"
              type="password"
              autoComplete="off"
              value={form.token}
              placeholder={
                editing ? '••••••••（留空保持不变）' : 'ghp_… / gitea token / gitee token'
              }
              onChange={(event) => setForm({ ...form, token: event.target.value })}
            />
          </Field>

          <Toggle
            checked={form.verify}
            onChange={(value) => setForm({ ...form, verify: value })}
            label="保存前验证连接"
            description="会调用 /user 接口确认 Token 有效，并记录账号头像与用户名。"
          />
        </div>
      </Modal>

      <RepositoryBrowserModal account={browsing} onClose={() => setBrowsing(null)} />
    </div>
  );
}

function RepositoryBrowserModal({
  account,
  onClose,
}: {
  account: Account | null;
  onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const repositories = useQuery({
    queryKey: ['account-repositories', account?.id, page, search],
    queryFn: () => api.accounts.repositories(account?.id ?? '', { page, perPage: 50, search }),
    enabled: account !== null,
  });

  const importRepository = useMutation({
    mutationFn: (item: RemoteRepositorySummary) =>
      api.repositories.import({ accountId: account?.id ?? '', fullName: item.fullName }),
    onSuccess: (data) => {
      toast.success(`已导入 ${data.repository.fullName}`);
      void queryClient.invalidateQueries({ queryKey: ['account-repositories'] });
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Modal
      open={account !== null}
      onClose={onClose}
      width="max-w-3xl"
      title={`${account?.name ?? ''} 的仓库`}
      description="选择要交给 AutoGit 托管的仓库，导入后即可初始化 ai/* 标签。"
      footer={
        <>
          <button
            type="button"
            className="btn"
            disabled={(repositories.data?.page ?? 1) <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            上一页
          </button>
          <span className="text-[11px] text-slate-500">
            第 {repositories.data?.page ?? page} 页
          </span>
          <button
            type="button"
            className="btn"
            disabled={!repositories.data?.hasMore}
            onClick={() => setPage((value) => value + 1)}
          >
            下一页
          </button>
          <Link to="/repositories" className="btn btn-primary" onClick={onClose}>
            前往仓库列表
          </Link>
        </>
      }
    >
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            className="input pl-9"
            placeholder="搜索仓库名，例如 autogit 或 owner/repo"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>

        {repositories.isLoading ? (
          <div className="space-y-2">
            {['a1', 'a2', 'a3', 'a4', 'a5'].map((slot) => (
              <Skeleton key={slot} className="h-14" />
            ))}
          </div>
        ) : repositories.isError ? (
          <EmptyState
            icon={<TriangleAlert className="h-5 w-5" />}
            title="无法读取仓库列表"
            description={errorMessage(repositories.error)}
          />
        ) : (repositories.data?.items.length ?? 0) === 0 ? (
          <EmptyState icon={<GitBranch className="h-5 w-5" />} title="没有匹配的仓库" />
        ) : (
          <div className="scroll-thin max-h-[46vh] space-y-2 overflow-y-auto pr-1">
            {repositories.data?.items.map((item) => (
              <div
                key={item.fullName}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-white/[0.02] px-3.5 py-2.5"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate text-[12.5px] text-slate-200">
                    {item.fullName}
                    {item.private && (
                      <span className="chip border-amber-400/30 text-amber-200">私有</span>
                    )}
                  </p>
                  <p className="mt-0.5 truncate text-[10.5px] text-slate-500">
                    默认分支 {item.defaultBranch}
                    {item.description ? ` · ${item.description}` : ''}
                  </p>
                </div>
                {item.imported && item.repositoryId ? (
                  <Link
                    to={`/repositories/${item.repositoryId}`}
                    className="btn text-[11px]"
                    onClick={onClose}
                  >
                    <CircleCheck className="h-3.5 w-3.5 text-emerald-400" />
                    已导入
                  </Link>
                ) : (
                  <button
                    type="button"
                    className="btn text-[11px]"
                    disabled={importRepository.isPending}
                    onClick={() => importRepository.mutate(item)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    导入
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
