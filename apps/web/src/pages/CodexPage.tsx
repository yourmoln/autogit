import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheck,
  Download,
  KeyRound,
  RefreshCw,
  Save,
  Terminal,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CodeBlock, InfoRow, SectionCard, Skeleton, Spinner } from '../components/primitives.js';
import { api, errorMessage } from '../lib/api.js';
import { cn, formatDateTime, formatRelative } from '../lib/utils.js';

export function CodexPage(): ReactNode {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const status = useQuery({
    queryKey: ['codex-status'],
    queryFn: () => api.codex.status(false),
    refetchInterval: 60_000,
  });

  const install = useQuery({
    queryKey: ['codex-install'],
    queryFn: api.codex.installState,
    refetchInterval: (query) => (query.state.data?.state.running ? 1_500 : false),
  });

  const config = useQuery({ queryKey: ['codex-config'], queryFn: api.codex.config });

  useEffect(() => {
    if (config.data && !dirty) setDraft(config.data.config.content);
  }, [config.data, dirty]);

  const runInstall = useMutation({
    mutationFn: api.codex.install,
    onSuccess: (data) => {
      toast[data.state.exitCode === 0 ? 'success' : 'error'](
        data.state.exitCode === 0
          ? 'Codex CLI 已更新'
          : `安装失败（退出码 ${data.state.exitCode}）`,
      );
      void queryClient.invalidateQueries({ queryKey: ['codex-install'] });
      void queryClient.invalidateQueries({ queryKey: ['codex-status'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const recheck = useMutation({
    mutationFn: api.codex.invalidate,
    onSuccess: (data) => {
      queryClient.setQueryData(['codex-status'], data);
      toast.success('已重新检测 Codex CLI');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const saveConfig = useMutation({
    mutationFn: (content: string) => api.codex.saveConfig(content),
    onSuccess: (data) => {
      toast.success('config.toml 已保存（已自动备份旧版本）');
      queryClient.setQueryData(['codex-config'], data);
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['codex-status'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const codexStatus = status.data?.status;
  const installState = install.data?.state;

  return (
    <div className="space-y-4">
      <SectionCard
        title="Codex CLI 状态"
        description="AutoGit 的所有 AI 能力（实现 / 评审 / 修复）都通过本机 Codex CLI 执行。"
        actions={
          <>
            <button
              type="button"
              className="btn text-[11.5px]"
              onClick={() => recheck.mutate()}
              disabled={recheck.isPending}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', recheck.isPending && 'animate-spin')} />
              重新检测
            </button>
            <button
              type="button"
              className="btn btn-primary text-[11.5px]"
              onClick={() => runInstall.mutate()}
              disabled={runInstall.isPending || installState?.running}
            >
              {runInstall.isPending || installState?.running ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {codexStatus?.installed ? '更新到最新版' : '下载并安装'}
            </button>
          </>
        }
      >
        {status.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-6 w-1/2" />
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'chip',
                    codexStatus?.installed
                      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
                      : 'border-rose-400/30 bg-rose-400/10 text-rose-200',
                  )}
                >
                  {codexStatus?.installed ? (
                    <CircleCheck className="h-3 w-3" />
                  ) : (
                    <TriangleAlert className="h-3 w-3" />
                  )}
                  {codexStatus?.installed ? '已安装' : '未安装'}
                </span>
                {codexStatus?.version && (
                  <span className="chip border-white/10 font-mono text-slate-300">
                    v{codexStatus.version}
                  </span>
                )}
                <span className="chip border-white/10 text-slate-400">
                  来源：
                  {codexStatus?.source === 'configured'
                    ? '手动指定路径'
                    : codexStatus?.source === 'path'
                      ? 'PATH 检测'
                      : '未找到'}
                </span>
                <span
                  className={cn(
                    'chip',
                    codexStatus?.loggedIn
                      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
                      : 'border-amber-400/30 bg-amber-400/10 text-amber-200',
                  )}
                >
                  <KeyRound className="h-3 w-3" />
                  {codexStatus?.loggedIn === null
                    ? '登录状态未知'
                    : codexStatus?.loggedIn
                      ? '已登录'
                      : '未登录'}
                </span>
              </div>

              {codexStatus?.warning && (
                <p className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/8 px-3 py-2 text-[11.5px] text-amber-200">
                  {codexStatus.warning}
                </p>
              )}

              {codexStatus?.loggedIn === false && (
                <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/8 px-3 py-2.5 text-[11.5px] leading-relaxed text-amber-100">
                  检测到 Codex CLI 尚未登录。AutoGit 不会代管账号凭证，请在终端执行一次
                  <code className="mx-1 rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px]">
                    codex login
                  </code>
                  完成设备授权，然后点击「重新检测」。
                </div>
              )}

              <div className="mt-3">
                <InfoRow
                  label="可执行文件"
                  value={
                    <span className="font-mono text-[10.5px]">
                      {codexStatus?.binaryPath ?? '—'}
                    </span>
                  }
                />
                <InfoRow
                  label="配置文件"
                  value={
                    <span className="font-mono text-[10.5px]">
                      {codexStatus?.configPath ?? '—'}
                    </span>
                  }
                />
                <InfoRow
                  label="凭证文件"
                  value={
                    <span className="font-mono text-[10.5px]">{codexStatus?.authPath ?? '—'}</span>
                  }
                />
                <InfoRow label="认证方式" value={codexStatus?.authMode ?? '—'} />
                <InfoRow label="检测时间" value={formatDateTime(codexStatus?.checkedAt)} />
              </div>
            </div>

            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                能力探测（codex exec --help）
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {codexStatus?.capabilities ? (
                  Object.entries({
                    'codex exec': codexStatus.capabilities.execCommand,
                    'JSON 事件流': codexStatus.capabilities.jsonOutput,
                    '沙箱模式 (--sandbox)': codexStatus.capabilities.sandboxFlag,
                    '配置覆盖 (-c)': codexStatus.capabilities.configOverride,
                    '工作目录 (--cd)': codexStatus.capabilities.cdFlag,
                    '非 Git 目录运行': codexStatus.capabilities.skipGitRepoCheck,
                    '模型选择 (-m)': codexStatus.capabilities.modelFlag,
                    '最后消息输出 (-o)': codexStatus.capabilities.outputLastMessage,
                    'JSON Schema 输出': codexStatus.capabilities.outputSchema,
                    评审子命令: codexStatus.capabilities.reviewSubcommand,
                    自更新子命令: codexStatus.capabilities.updateSubcommand,
                  }).map(([label, enabled]) => (
                    <span
                      key={label}
                      className={cn(
                        'chip justify-start',
                        enabled
                          ? 'border-emerald-400/25 bg-emerald-400/8 text-emerald-200'
                          : 'border-white/10 text-slate-500',
                      )}
                    >
                      {enabled ? (
                        <CircleCheck className="h-3 w-3" />
                      ) : (
                        <TriangleAlert className="h-3 w-3" />
                      )}
                      {label}
                    </span>
                  ))
                ) : (
                  <p className="text-[11.5px] text-slate-500">未安装时无法探测能力。</p>
                )}
              </div>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="安装 / 更新输出"
        description={
          installState?.command
            ? `命令：${installState.command}${installState.running ? ' · 执行中…' : ' · 已结束'}`
            : codexStatus?.installed
              ? '已安装时会优先使用 codex update 自更新，否则回退到 npm 全局安装。'
              : '将执行 npm install -g @openai/codex@latest'
        }
        actions={
          installState?.finishedAt ? (
            <span className="chip border-white/10 text-slate-400">
              结束于 {formatRelative(installState.finishedAt)}
            </span>
          ) : null
        }
        bodyClassName="p-0"
      >
        <div className="max-h-72 overflow-hidden">
          {installState && installState.lines.length > 0 ? (
            <div className="scroll-thin max-h-72 space-y-0.5 overflow-y-auto bg-black/40 px-3 py-2">
              {installState.lines.map((line, index) => {
                // Install output can contain identical lines; the index keeps
                // the timestamp + position pair unique.
                const lineKey = `${line.ts}#${index}`;
                return (
                  <p
                    key={lineKey}
                    className={cn(
                      'log-line',
                      line.stream === 'stderr'
                        ? 'text-rose-300'
                        : line.stream === 'system'
                          ? 'text-indigo-200'
                          : 'text-slate-300',
                    )}
                  >
                    <span className="mr-2 text-slate-600">{line.ts.slice(11, 19)}</span>
                    {line.message}
                  </p>
                );
              })}
            </div>
          ) : (
            <p className="px-4 py-6 text-center text-[11.5px] text-slate-500">
              暂无安装输出。点击右上角「下载并安装」开始，输出会实时显示在这里。
            </p>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="config.toml"
        description={
          config.data?.config.parseError
            ? `⚠️ 当前文件解析失败：${config.data.config.parseError}`
            : `保存前会做 TOML 校验，并自动备份到 ${config.data?.config.path ?? ''}/../autogit-backups`
        }
        actions={
          <>
            {dirty && (
              <span className="chip border-amber-400/30 bg-amber-400/10 text-amber-200">
                有未保存修改
              </span>
            )}
            <button
              type="button"
              className="btn text-[11.5px]"
              disabled={!dirty || draft === null}
              onClick={() => {
                setDirty(false);
                setDraft(config.data?.config.content ?? null);
              }}
            >
              放弃修改
            </button>
            <button
              type="button"
              className="btn btn-primary text-[11.5px]"
              disabled={!dirty || draft === null || saveConfig.isPending}
              onClick={() => draft !== null && saveConfig.mutate(draft)}
            >
              {saveConfig.isPending ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              保存配置
            </button>
          </>
        }
      >
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div>
            <textarea
              className="textarea font-mono text-[11.5px]"
              style={{ minHeight: '20rem' }}
              value={draft ?? ''}
              spellCheck={false}
              onChange={(event) => {
                setDraft(event.target.value);
                setDirty(true);
              }}
            />
            {config.data?.config.highlights && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(config.data.config.highlights)
                  .filter(([, value]) => Boolean(value))
                  .map(([key, value]) => (
                    <span
                      key={key}
                      className="chip border-indigo-400/25 bg-indigo-400/8 text-indigo-200"
                    >
                      {key} = {String(value)}
                    </span>
                  ))}
              </div>
            )}
          </div>
          <div className="space-y-3">
            <div className="rounded-xl border border-white/8 bg-white/[0.02] px-3.5 py-3">
              <p className="flex items-center gap-2 text-[11.5px] font-medium text-slate-200">
                <Terminal className="h-3.5 w-3.5 text-indigo-300" />
                常用字段说明
              </p>
              <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-slate-400">
                <li>
                  <code className="font-mono text-slate-300">model</code>：执行模型，留空则用 Codex
                  默认值。
                </li>
                <li>
                  <code className="font-mono text-slate-300">sandbox_mode</code>：建议
                  workspace-write，AutoGit 已为任务准备独立工作区。
                </li>
                <li>
                  <code className="font-mono text-slate-300">approval_policy</code>：自动化场景使用
                  never。
                </li>
              </ul>
            </div>
            <div className="rounded-xl border border-white/8 bg-white/[0.02] px-3.5 py-3">
              <p className="text-[11.5px] font-medium text-slate-200">历史备份</p>
              {(config.data?.backups.length ?? 0) === 0 ? (
                <p className="mt-1.5 text-[11px] text-slate-500">还没有备份，首次保存后会生成。</p>
              ) : (
                <ul className="mt-1.5 space-y-1 text-[11px] text-slate-400">
                  {config.data?.backups.slice(0, 6).map((backup) => (
                    <li key={backup.name} className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[10.5px]">{backup.name}</span>
                      <span className="shrink-0 text-slate-500">
                        {formatDateTime(backup.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {config.data?.config.parsed && (
              <details className="rounded-xl border border-white/8 bg-black/30 px-3.5 py-3">
                <summary className="cursor-pointer text-[11.5px] text-slate-300">
                  查看解析后的 TOML
                </summary>
                <CodeBlock
                  className="mt-2"
                  maxHeight="max-h-56"
                  code={JSON.stringify(config.data.config.parsed, null, 2)}
                />
              </details>
            )}
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
