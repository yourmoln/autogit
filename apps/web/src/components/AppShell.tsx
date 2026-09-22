import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Bot,
  GitBranch,
  LayoutDashboard,
  ListChecks,
  Plug,
  RefreshCw,
  Settings as SettingsIcon,
  Tags,
  Terminal,
  TriangleAlert,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { useRealtimeBridge, useRealtimeConnection } from '../hooks/useRealtime.js';
import { api, errorMessage } from '../lib/api.js';
import { cn, formatRelative } from '../lib/utils.js';
import { Spinner } from './primitives.js';

const NAV_ITEMS = [
  { to: '/', label: '总览', icon: LayoutDashboard, end: true, hint: '流水线状态与实时动态' },
  { to: '/accounts', label: 'Git 账号', icon: Plug, hint: 'GitHub / Gitea / Gitee 凭证' },
  { to: '/repositories', label: '仓库', icon: GitBranch, hint: '导入仓库并初始化标签' },
  { to: '/tasks', label: '任务', icon: ListChecks, hint: '队列、执行历史与实时日志' },
  { to: '/codex', label: 'Codex CLI', icon: Terminal, hint: '安装、版本与配置' },
  { to: '/labels', label: '标签规范', icon: Tags, hint: 'ai/* 标签语义与流转' },
  { to: '/settings', label: '设置', icon: SettingsIcon, hint: '轮询、并发与提示词' },
] as const;

const PAGE_TITLES: Record<string, { title: string; subtitle: string }> = {
  '/': { title: '流水线总览', subtitle: 'ai/* 标签驱动的 Issue → PR → 评审 → 修复闭环' },
  '/accounts': {
    title: 'Git 账号',
    subtitle: '配置多平台凭证，AutoGit 会用它们读取 Issue 与推送 PR',
  },
  '/repositories': {
    title: '仓库',
    subtitle: '选择账号下的仓库，初始化 ai/* 标签后即可托管流水线',
  },
  '/tasks': { title: '任务', subtitle: 'Codex 执行队列、历史记录与逐字实时日志' },
  '/codex': { title: 'Codex CLI', subtitle: '下载安装、版本识别、登录状态与 config.toml 管理' },
  '/labels': { title: '标签规范', subtitle: '15 个 ai/* 标签的语义、单选分组与流转规则' },
  '/settings': { title: '设置', subtitle: '调度节奏、并发、沙箱与提交身份' },
};

export function AppShell(): ReactNode {
  useRealtimeBridge();
  const connection = useRealtimeConnection();
  const location = useLocation();
  const queryClient = useQueryClient();

  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    refetchInterval: 20_000,
  });
  const codex = useQuery({
    queryKey: ['codex-status'],
    queryFn: () => api.codex.status(),
    refetchInterval: 120_000,
  });

  const basePath = location.pathname.startsWith('/repositories/')
    ? '/repositories'
    : location.pathname;
  const heading = PAGE_TITLES[basePath] ?? PAGE_TITLES['/repositories']!;

  const stats = overview.data?.stats;
  const orchestrator = overview.data?.orchestrator;
  const runningCount = orchestrator?.runningTaskIds.length ?? 0;
  const queuedCount = orchestrator?.queuedTaskIds.length ?? 0;

  const tick = async (): Promise<void> => {
    try {
      await api.tick();
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
      toast.success('已完成一次手动轮询');
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-white/6 bg-[#080a0f]/85 backdrop-blur-xl lg:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 shadow-lg shadow-indigo-500/30">
            <Bot className="h-5 w-5 text-white" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-tight text-slate-100">AutoGit</p>
            <p className="text-[10.5px] text-slate-500">Agent Git Workflow</p>
          </div>
        </div>

        <nav className="scroll-thin flex-1 space-y-1 overflow-y-auto px-3 pb-4">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item ? item.end : false}
              className={({ isActive }) =>
                cn(
                  'group relative flex items-start gap-2.5 rounded-xl px-3 py-2 text-[13px] transition-colors',
                  isActive
                    ? 'bg-gradient-to-r from-indigo-500/18 to-violet-500/8 text-slate-100'
                    : 'text-slate-400 hover:bg-white/4 hover:text-slate-200',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <motion.span
                      layoutId="nav-active"
                      className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-gradient-to-b from-indigo-400 to-violet-400"
                    />
                  )}
                  <item.icon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block font-medium">{item.label}</span>
                    <span className="block truncate text-[10.5px] text-slate-500">{item.hint}</span>
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="space-y-3 border-t border-white/6 px-3 py-4">
          <div className="rounded-xl border border-white/8 bg-white/[0.025] px-3 py-2.5">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-slate-300">
                <Activity className="h-3.5 w-3.5 text-indigo-300" />
                调度器
              </span>
              <span
                className={cn(
                  'flex items-center gap-1 text-[10.5px]',
                  connection === 'online' ? 'text-emerald-300' : 'text-amber-300',
                )}
              >
                {connection === 'online' ? (
                  <Wifi className="h-3 w-3" />
                ) : (
                  <WifiOff className="h-3 w-3" />
                )}
                {connection === 'online' ? '实时' : '重连中'}
              </span>
            </div>
            <dl className="mt-2 space-y-1 text-[11px] text-slate-400">
              <div className="flex justify-between">
                <dt>运行中</dt>
                <dd className="font-mono text-slate-200">{runningCount}</dd>
              </div>
              <div className="flex justify-between">
                <dt>排队中</dt>
                <dd className="font-mono text-slate-200">{queuedCount}</dd>
              </div>
              <div className="flex justify-between">
                <dt>下次轮询</dt>
                <dd className="text-slate-300">
                  {formatRelative(orchestrator?.nextTickAt ?? null)}
                </dd>
              </div>
            </dl>
            <button
              type="button"
              className="btn mt-2.5 w-full justify-center text-[11.5px]"
              onClick={tick}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              立即轮询
            </button>
          </div>

          <div className="px-1 text-[10.5px] text-slate-600">
            v0.1.0 ·{' '}
            {stats ? `${stats.repositories} 仓库 · ${stats.trackedIssues} Issue` : '正在加载统计…'}
          </div>
        </div>
      </aside>

      <div className="flex min-h-screen w-full flex-col lg:pl-60">
        <header className="sticky top-0 z-20 border-b border-white/6 bg-[#07090d]/80 px-4 py-3.5 backdrop-blur-xl sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-[15px] font-semibold tracking-tight text-slate-100">
                {heading.title}
              </h1>
              <p className="truncate text-[11.5px] text-slate-500">{heading.subtitle}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <CodexChip status={codex.data?.status} loading={codex.isLoading} />
              {orchestrator?.lastTickError && (
                <span className="chip border-amber-400/30 bg-amber-400/10 text-amber-200">
                  <TriangleAlert className="h-3 w-3" />
                  轮询异常
                </span>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 px-4 py-5 sm:px-6 sm:py-6">
          <Outlet />
        </main>

        <footer className="border-t border-white/6 px-4 py-3 text-[11px] text-slate-600 sm:px-6">
          AutoGit · 由 Codex CLI 驱动的自动化 Git 工作流 · 所有 AI 能力均通过本机 Codex CLI 执行
        </footer>
      </div>
    </div>
  );
}

function CodexChip({
  status,
  loading,
}: {
  status: { installed: boolean; version: string | null; loggedIn: boolean | null } | undefined;
  loading: boolean;
}): ReactNode {
  if (loading && !status) {
    return (
      <span className="chip border-white/10 text-slate-400">
        <Spinner className="h-3 w-3" />
        检测 Codex…
      </span>
    );
  }
  if (!status?.installed) {
    return (
      <span className="chip border-rose-400/30 bg-rose-400/10 text-rose-200">
        <TriangleAlert className="h-3 w-3" />
        未检测到 Codex CLI
      </span>
    );
  }
  return (
    <span
      className={cn(
        'chip',
        status.loggedIn
          ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
          : 'border-amber-400/30 bg-amber-400/10 text-amber-200',
      )}
      title={status.loggedIn ? 'Codex CLI 已登录' : 'Codex CLI 未登录，请先在终端执行 codex login'}
    >
      <Terminal className="h-3 w-3" />
      Codex {status.version ?? '未知版本'}
      {status.loggedIn === false ? ' · 未登录' : ''}
    </span>
  );
}
