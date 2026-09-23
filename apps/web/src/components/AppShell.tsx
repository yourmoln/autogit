import type { CodexStatus } from '@autogit/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Bot,
  GitBranch,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Network,
  Plug,
  RefreshCw,
  Settings as SettingsIcon,
  Tags,
  Terminal,
  TriangleAlert,
  UserRound,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { motion } from 'motion/react';
import { type ReactNode, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { useRealtimeBridge, useRealtimeConnection } from '../hooks/useRealtime.js';
import { api, errorMessage } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { cn, formatRelative } from '../lib/utils.js';
import { Spinner } from './primitives.js';
import { ThemeToggle } from './ThemeToggle.js';

const NAV_ITEMS = [
  { to: '/', label: '总览', icon: LayoutDashboard, end: true, hint: '流水线状态与实时动态' },
  { to: '/accounts', label: 'Git 账号', icon: Plug, hint: 'GitHub / Gitea / Gitee 凭证' },
  { to: '/repositories', label: '仓库', icon: GitBranch, hint: '导入仓库并初始化标签' },
  { to: '/tasks', label: '任务', icon: ListChecks, hint: '队列、执行历史与实时日志' },
  { to: '/codex', label: 'Codex CLI', icon: Terminal, hint: '安装、版本与配置' },
  { to: '/proxy', label: '代理配置', icon: Network, hint: 'HTTP(S) / SOCKS5 代理与连通性' },
  { to: '/labels', label: '标签规范', icon: Tags, hint: 'ai/* 标签语义与流转' },
  { to: '/settings', label: '设置', icon: SettingsIcon, hint: '登录账号、轮询与并发' },
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
  '/codex': { title: 'Codex CLI', subtitle: '下载安装、版本识别、模型响应探测与 config.toml 管理' },
  '/proxy': {
    title: '代理配置',
    subtitle: '为 git 与平台接口配置 HTTP(S) / SOCKS5 代理，并测试 GitHub 连通性',
  },
  '/labels': { title: '标签规范', subtitle: '15 个 ai/* 标签的语义、单选分组与流转规则' },
  '/settings': { title: '设置', subtitle: '登录账号、调度节奏、并发、沙箱与提交身份' },
};

export function AppShell(): ReactNode {
  useRealtimeBridge();
  const connection = useRealtimeConnection();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { session, credentials, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);

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

  const signOut = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await logout();
      toast.success('已退出登录');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-white/6 bg-surface/85 backdrop-blur-xl lg:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 shadow-lg shadow-indigo-500/30">
            <Bot className="h-5 w-5 text-[#f8fafc]" />
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
          <div className="flex items-center justify-between gap-2 rounded-xl border border-white/8 bg-white/[0.025] px-3 py-2.5">
            <span className="flex min-w-0 items-center gap-2 text-[11.5px] text-slate-300">
              <UserRound className="h-3.5 w-3.5 shrink-0 text-indigo-300" />
              <span className="min-w-0">
                <span className="block truncate font-medium">{credentials?.username ?? '—'}</span>
                <span className="block text-[10.5px] text-slate-500">
                  {session?.persistent ? '保持登录' : '本次会话'}
                </span>
              </span>
            </span>
            <button
              type="button"
              className="btn btn-ghost px-2 py-1 text-[11px]"
              onClick={signOut}
              disabled={loggingOut}
              title="退出登录"
            >
              <LogOut className="h-3.5 w-3.5" />
              退出
            </button>
          </div>

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
        <header className="sticky top-0 z-20 border-b border-white/6 bg-canvas/80 px-4 py-3.5 backdrop-blur-xl sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-[15px] font-semibold tracking-tight text-slate-100">
                {heading.title}
              </h1>
              <p className="truncate text-[11.5px] text-slate-500">{heading.subtitle}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {credentials?.defaultCredentials && (
                <NavLink
                  to="/settings"
                  className="chip border-amber-400/30 bg-amber-400/10 text-amber-200"
                  title="仍在使用默认账号，点此前往设置修改"
                >
                  <TriangleAlert className="h-3 w-3" />
                  默认账号 {credentials.username}
                </NavLink>
              )}
              <span className="chip border-white/10 text-slate-300" title="当前登录账号">
                <UserRound className="h-3 w-3" />
                {credentials?.username ?? session?.username ?? '已登录'}
              </span>
              <button
                type="button"
                className="btn px-2.5 py-1.5 text-[11.5px]"
                onClick={signOut}
                disabled={loggingOut}
              >
                <LogOut className="h-3.5 w-3.5" />
                退出登录
              </button>
              <CodexChip status={codex.data?.status} loading={codex.isLoading} />
              {orchestrator?.lastTickError && (
                <span className="chip border-amber-400/30 bg-amber-400/10 text-amber-200">
                  <TriangleAlert className="h-3 w-3" />
                  轮询异常
                </span>
              )}
              <ThemeToggle />
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
  status: CodexStatus | undefined;
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

  const ready = status.modelProbe?.ready ?? null;
  const probeHint =
    ready === true
      ? 'Codex 模型响应正常'
      : ready === false
        ? `Codex 模型无响应：${status.modelProbe?.message ?? '未知原因'}`
        : '尚未探测 Codex 模型响应，可前往 Codex CLI 页面执行';

  return (
    <span
      className={cn(
        'chip',
        ready === true
          ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
          : ready === false
            ? 'border-rose-400/30 bg-rose-400/10 text-rose-200'
            : 'border-white/10 text-slate-300',
      )}
      title={probeHint}
    >
      <Terminal className="h-3 w-3" />
      Codex {status.version ?? '未知版本'}
      {ready === true ? ' · 模型正常' : ready === false ? ' · 模型无响应' : ''}
    </span>
  );
}
