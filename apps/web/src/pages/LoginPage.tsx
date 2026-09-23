import { DEFAULT_AUTH_PASSWORD, DEFAULT_AUTH_USERNAME } from '@autogit/shared';
import { Bot, Eye, EyeOff, KeyRound, LogIn, ShieldCheck, UserRound } from 'lucide-react';
import { motion } from 'motion/react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { Spinner } from '../components/primitives.js';
import { errorMessage } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { cn } from '../lib/utils.js';

/**
 * Login gate shown before any page renders.
 *
 * AutoGit ships with `admin` / `admin`, so the form also explains where the
 * credentials can be changed afterwards.
 */
export function LoginPage(): ReactNode {
  const { session, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [reveal, setReveal] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from;
  const redirectTo = from && from !== '/login' ? from : '/';

  if (session) return <Navigate to={redirectTo} replace />;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);
    try {
      const created = await login({ username, password, remember });
      toast.success(`欢迎回来，${created.username}`);
      navigate(redirectTo, { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
        className="w-full max-w-[420px]"
      >
        <div className="flex items-center gap-3 px-1">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 shadow-lg shadow-indigo-500/30">
            <Bot className="h-6 w-6 text-white" />
          </span>
          <div className="leading-tight">
            <p className="text-base font-semibold tracking-tight text-slate-100">AutoGit</p>
            <p className="text-[11.5px] text-slate-500">Agent Git Workflow · 登录后开始工作</p>
          </div>
        </div>

        <form onSubmit={submit} className="panel mt-5 space-y-4 px-5 py-5">
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-slate-100">登录</h1>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              所有页面与接口都需要登录，未登录访问会自动跳转到本页。
            </p>
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-300">用户名</span>
            <span className="relative block">
              <UserRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                className="input pl-9"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder={DEFAULT_AUTH_USERNAME}
                autoComplete="username"
                required
              />
            </span>
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-300">密码</span>
            <span className="relative block">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                className="input pl-9 pr-10"
                type={reveal ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="请输入密码"
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                onClick={() => setReveal((value) => !value)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-slate-500 transition-colors hover:text-slate-300"
                aria-label={reveal ? '隐藏密码' : '显示密码'}
              >
                {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </span>
          </label>

          <button
            type="button"
            onClick={() => setRemember((value) => !value)}
            className="flex w-full items-start gap-3 rounded-xl border border-white/8 bg-white/[0.02] px-3.5 py-3 text-left transition-colors hover:border-white/15"
            aria-pressed={remember}
          >
            <span
              className={cn(
                'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border transition-colors',
                remember
                  ? 'border-transparent bg-gradient-to-br from-indigo-500 to-violet-500'
                  : 'border-white/25 bg-white/5',
              )}
            >
              {remember && <ShieldCheck className="h-3 w-3 text-white" />}
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-medium text-slate-200">保持登录</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">
                勾选后登录凭证会保存在浏览器中，下次打开自动登录（30
                天内有效，期间使用会自动续期）。
              </span>
            </span>
          </button>

          {error && (
            <p className="rounded-xl border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-[11.5px] text-rose-200">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="btn btn-primary w-full justify-center"
            disabled={pending}
          >
            {pending ? <Spinner className="h-3.5 w-3.5" /> : <LogIn className="h-3.5 w-3.5" />}
            登录
          </button>

          <p className="text-[11px] leading-relaxed text-slate-500">
            首次使用请用默认账号 {DEFAULT_AUTH_USERNAME} / {DEFAULT_AUTH_PASSWORD}{' '}
            登录，之后可在「设置 → 登录与安全」中修改账号与密码。
          </p>
        </form>
      </motion.div>
    </div>
  );
}
