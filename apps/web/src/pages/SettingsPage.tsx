import {
  AUTH_MAX_PASSWORD_LENGTH,
  AUTH_MAX_USERNAME_LENGTH,
  AUTH_MIN_PASSWORD_LENGTH,
  AUTH_MIN_USERNAME_LENGTH,
  type AppSettings,
} from '@autogit/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, RefreshCw, Save, Server, ShieldAlert, ShieldCheck } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Field,
  InfoRow,
  SectionCard,
  Skeleton,
  Spinner,
  Toggle,
} from '../components/primitives.js';
import { api, errorMessage } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { formatDateTime } from '../lib/utils.js';

export function SettingsPage(): ReactNode {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<AppSettings | null>(null);
  const [dirty, setDirty] = useState(false);

  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.get });

  useEffect(() => {
    if (settings.data && !dirty) setForm(settings.data.settings);
  }, [settings.data, dirty]);

  const save = useMutation({
    mutationFn: (payload: Partial<AppSettings>) => api.settings.update(payload),
    onSuccess: (data) => {
      toast.success('设置已保存');
      queryClient.setQueryData(['settings'], (previous: typeof settings.data) =>
        previous ? { ...previous, settings: data.settings } : previous,
      );
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['codex-status'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const restart = useMutation({
    mutationFn: api.restartOrchestrator,
    onSuccess: () => {
      toast.success('调度器已重启并应用最新设置');
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (!form) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const patch = (value: Partial<AppSettings>): void => {
    setForm({ ...form, ...value });
    setDirty(true);
  };

  return (
    <div className="space-y-4">
      <AccountSecurityCard />

      <SectionCard
        title="调度设置"
        description="轮询节奏与并发上限：全局并发决定同时运行的任务总数，单仓库并发决定同一个仓库能同时跑几个任务（每个任务有独立工作区）。修改后点击保存，必要时重启调度器立即生效。"
        actions={
          <>
            <button
              type="button"
              className="btn text-[11.5px]"
              onClick={() => restart.mutate()}
              disabled={restart.isPending}
            >
              <RefreshCw
                className={restart.isPending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
              />
              重启调度器
            </button>
            <button
              type="button"
              className="btn btn-primary text-[11.5px]"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate(form)}
            >
              {save.isPending ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              保存设置
            </button>
          </>
        }
        bodyClassName="space-y-4"
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Field label="轮询间隔（秒）" hint="10 - 3600">
            <input
              type="number"
              className="input"
              min={10}
              max={3600}
              value={form.pollSeconds}
              onChange={(event) => patch({ pollSeconds: Number(event.target.value) })}
            />
          </Field>
          <Field label="全局并发任务数" hint="1 - 8">
            <input
              type="number"
              className="input"
              min={1}
              max={8}
              value={form.maxConcurrentTasks}
              onChange={(event) => patch({ maxConcurrentTasks: Number(event.target.value) })}
            />
          </Field>
          <Field label="单仓库并发任务数" hint="1 - 8，默认 1；每个仓库可同时运行的任务数">
            <input
              type="number"
              className="input"
              min={1}
              max={8}
              value={form.maxConcurrentPerRepo}
              onChange={(event) => patch({ maxConcurrentPerRepo: Number(event.target.value) })}
            />
          </Field>
          <Field label="单任务超时（分钟）" hint="5 - 240">
            <input
              type="number"
              className="input"
              min={5}
              max={240}
              value={form.taskTimeoutMinutes}
              onChange={(event) => patch({ taskTimeoutMinutes: Number(event.target.value) })}
            />
          </Field>
          <Field label="分支前缀" hint="AI 分支必须以该前缀开头，避免误推人工分支">
            <input
              className="input font-mono text-xs"
              value={form.branchPrefix}
              onChange={(event) => patch({ branchPrefix: event.target.value })}
            />
          </Field>
          <Field label="PR 标题模板" hint="可用 {issueTitle} / {issueNumber}">
            <input
              className="input font-mono text-xs"
              value={form.prTitleTemplate}
              onChange={(event) => patch({ prTitleTemplate: event.target.value })}
            />
          </Field>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <Toggle
            checked={form.autoReview}
            onChange={(value) => patch({ autoReview: value })}
            label="自动评审 ai/needs-review"
            description="PR 打上 ai/needs-review 后自动排队调用 Codex 评审。"
          />
          <Toggle
            checked={form.autoFix}
            onChange={(value) => patch({ autoFix: value })}
            label="自动修复 ai/needs-fix"
            description="评审未通过时自动按意见修复并回推分支。"
          />
          <Toggle
            checked={form.autoInitializeLabels}
            onChange={(value) => patch({ autoInitializeLabels: value })}
            label="导入仓库时自动初始化标签"
            description="默认关闭，推荐在仓库页面手动点击「初始化」以确认会创建哪些标签。"
          />
          <Toggle
            checked={form.allowClaudeFallback}
            onChange={(value) => patch({ allowClaudeFallback: value })}
            label="允许 ai/prefer-claude 使用 Claude CLI"
            description="关闭后所有任务都强制走 Codex CLI；开启时需要本机已安装 claude 命令。"
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Codex 执行参数"
        description="这些参数会附加到每次 codex exec 调用上（仅使用当前版本支持的开关）。"
        bodyClassName="space-y-4"
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Codex 可执行文件路径" hint="留空则从 PATH 查找">
            <input
              className="input font-mono text-xs"
              placeholder="C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd"
              value={form.codexPath ?? ''}
              onChange={(event) => patch({ codexPath: event.target.value || null })}
            />
          </Field>
          <Field label="模型" hint="留空使用 config.toml">
            <input
              className="input font-mono text-xs"
              placeholder="gpt-5-codex"
              value={form.codexModel ?? ''}
              onChange={(event) => patch({ codexModel: event.target.value || null })}
            />
          </Field>
          <Field label="沙箱模式">
            <select
              className="select"
              value={form.codexSandbox}
              onChange={(event) =>
                patch({ codexSandbox: event.target.value as AppSettings['codexSandbox'] })
              }
            >
              <option value="read-only">read-only（只读，无法改代码）</option>
              <option value="workspace-write">workspace-write（推荐）</option>
              <option value="danger-full-access">danger-full-access（谨慎）</option>
            </select>
          </Field>
          <Field label="审批策略">
            <select
              className="select"
              value={form.codexApprovalPolicy}
              onChange={(event) =>
                patch({
                  codexApprovalPolicy: event.target.value as AppSettings['codexApprovalPolicy'],
                })
              }
            >
              <option value="never">never（自动化推荐）</option>
              <option value="on-failure">on-failure</option>
              <option value="on-request">on-request</option>
              <option value="untrusted">untrusted</option>
            </select>
          </Field>
        </div>
        <Field label="附加参数" hint="用空格分隔，会原样追加到 codex exec 命令行">
          <input
            className="input font-mono text-xs"
            placeholder="例如：--enable web_search 或 --profile work"
            value={form.codexExtraArgs.join(' ')}
            onChange={(event) =>
              patch({
                codexExtraArgs: event.target.value.split(/\s+/).filter((item) => item.length > 0),
              })
            }
          />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="提交作者名" hint="用于 AI 生成的提交">
            <input
              className="input"
              value={form.commitAuthorName}
              onChange={(event) => patch({ commitAuthorName: event.target.value })}
            />
          </Field>
          <Field label="提交作者邮箱">
            <input
              className="input font-mono text-xs"
              value={form.commitAuthorEmail}
              onChange={(event) => patch({ commitAuthorEmail: event.target.value })}
            />
          </Field>
        </div>
      </SectionCard>

      <SectionCard
        title="运行环境"
        description="AutoGit 会把数据库、工作区与日志都放在本地数据目录中。"
        bodyClassName="grid gap-4 lg:grid-cols-2"
      >
        <div>
          <div className="flex items-center gap-2 text-[12px] font-medium text-slate-200">
            <Server className="h-3.5 w-3.5 text-indigo-300" />
            路径信息
          </div>
          <div className="mt-2">
            <InfoRow
              label="数据目录"
              value={<span className="font-mono text-[10.5px]">{settings.data?.runtime.home}</span>}
            />
            <InfoRow
              label="SQLite"
              value={
                <span className="font-mono text-[10.5px]">{settings.data?.runtime.dbFile}</span>
              }
            />
            <InfoRow
              label="工作区"
              value={
                <span className="font-mono text-[10.5px]">
                  {settings.data?.runtime.workspacesDir}
                </span>
              }
            />
            <InfoRow
              label="Codex Home"
              value={
                <span className="font-mono text-[10.5px]">{settings.data?.runtime.codexHome}</span>
              }
            />
            <InfoRow
              label="前端产物"
              value={
                <span className="font-mono text-[10.5px]">
                  {settings.data?.runtime.webDist ?? '未构建（开发模式）'}
                </span>
              }
            />
            <InfoRow
              label="监听地址"
              value={`${settings.data?.runtime.host}:${settings.data?.runtime.port}`}
            />
            <InfoRow label="Node 版本" value={settings.data?.runtime.nodeVersion ?? '—'} />
          </div>
        </div>
        <div className="rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-3.5 text-[11.5px] leading-relaxed text-slate-400">
          <p className="text-[12px] font-medium text-slate-200">数据与安全</p>
          <ul className="mt-2 space-y-1.5">
            <li>· Git Token 使用 AES-256-GCM 加密存储，密钥位于数据目录的 secret.key。</li>
            <li>
              · 代码改动全部发生在 ~/.autogit/workspaces 下的独立克隆中，不会污染你本地的开发目录。
            </li>
            <li>· 推送权限仅用于 AI 分支（默认 ai/issue-*），不会强推人工分支。</li>
            <li>· 所有 AI 调用都在本机 Codex CLI 内执行，AutoGit 不代理任何模型请求。</li>
          </ul>
        </div>
      </SectionCard>
    </div>
  );
}

/**
 * 登录账号管理。
 *
 * AutoGit 是单用户工具，账号只有一份：这里改掉的用户名/密码就是下次登录要
 * 用的凭据。修改需要验证当前密码，保存后其他设备上的登录状态会立即失效。
 */
function AccountSecurityCard(): ReactNode {
  const { credentials, session, updateCredentials, logout } = useAuth();

  const [username, setUsername] = useState('');
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    // 服务端账号变化时回填，但不覆盖用户正在输入的内容。
    if (credentials && !usernameEdited) setUsername(credentials.username);
  }, [credentials, usernameEdited]);

  const trimmedUsername = username.trim();
  const usernameTooShort = trimmedUsername.length < AUTH_MIN_USERNAME_LENGTH;
  const passwordTooShort =
    nextPassword.length > 0 &&
    (nextPassword.length < AUTH_MIN_PASSWORD_LENGTH ||
      nextPassword.length > AUTH_MAX_PASSWORD_LENGTH);
  const mismatch = nextPassword.length > 0 && nextPassword !== confirmPassword;
  const dirty =
    (credentials !== null && trimmedUsername !== credentials.username) || nextPassword.length > 0;
  const canSubmit =
    dirty &&
    currentPassword.length > 0 &&
    !usernameTooShort &&
    !passwordTooShort &&
    !mismatch &&
    trimmedUsername.length <= AUTH_MAX_USERNAME_LENGTH;

  const save = useMutation({
    mutationFn: () =>
      updateCredentials({
        currentPassword,
        username: trimmedUsername,
        password: nextPassword.length > 0 ? nextPassword : null,
      }),
    onSuccess: (updated) => {
      toast.success(`登录账号已更新：${updated.username}`);
      setUsername(updated.username);
      setUsernameEdited(false);
      setCurrentPassword('');
      setNextPassword('');
      setConfirmPassword('');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const signOut = useMutation({
    mutationFn: logout,
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <SectionCard
      title="登录与安全"
      description="访问 AutoGit 的所有页面与接口都需要登录；首次使用的默认账号是 admin / admin，请在这里改成自己的账号与密码。"
      actions={
        <>
          <button
            type="button"
            className="btn text-[11.5px]"
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
          >
            <LogOut className="h-3.5 w-3.5" />
            退出登录
          </button>
          <button
            type="button"
            className="btn btn-primary text-[11.5px]"
            onClick={() => save.mutate()}
            disabled={!canSubmit || save.isPending}
          >
            {save.isPending ? (
              <Spinner className="h-3.5 w-3.5" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            保存账号与密码
          </button>
        </>
      }
      bodyClassName="space-y-4"
    >
      {credentials?.defaultCredentials && (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-400/25 bg-amber-400/8 px-3.5 py-3 text-[11.5px] leading-relaxed text-amber-100">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <span>
            当前仍在使用默认账号 admin /
            admin。凡是能访问该端口的人都能登录，请立即修改用户名与密码。
          </span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="用户名"
          hint={`${AUTH_MIN_USERNAME_LENGTH} - ${AUTH_MAX_USERNAME_LENGTH} 个字符`}
          error={usernameTooShort ? '用户名太短' : undefined}
        >
          <input
            className="input"
            value={username}
            autoComplete="username"
            onChange={(event) => {
              setUsername(event.target.value);
              setUsernameEdited(true);
            }}
          />
        </Field>
        <Field label="当前密码" hint="修改任意一项都需要验证">
          <input
            className="input"
            type="password"
            value={currentPassword}
            autoComplete="current-password"
            placeholder="请输入当前登录密码"
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </Field>
        <Field
          label="新密码"
          hint={`留空表示不修改 · ${AUTH_MIN_PASSWORD_LENGTH} - ${AUTH_MAX_PASSWORD_LENGTH} 个字符`}
          error={passwordTooShort ? '新密码长度不符合要求' : undefined}
        >
          <input
            className="input"
            type="password"
            value={nextPassword}
            autoComplete="new-password"
            placeholder="留空则只修改用户名"
            onChange={(event) => setNextPassword(event.target.value)}
          />
        </Field>
        <Field label="确认新密码" error={mismatch ? '两次输入的新密码不一致' : undefined}>
          <input
            className="input"
            type="password"
            value={confirmPassword}
            autoComplete="new-password"
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </Field>
      </div>

      <div className="rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-3 text-[11.5px] leading-relaxed text-slate-400">
        <p className="flex items-center gap-2 text-[12px] font-medium text-slate-200">
          <KeyRound className="h-3.5 w-3.5 text-indigo-300" />
          会话信息
        </p>
        <div className="mt-1.5">
          <InfoRow label="当前账号" value={credentials?.username ?? '—'} />
          <InfoRow
            label="登录方式"
            value={
              session?.persistent ? (
                <span className="flex items-center justify-end gap-1.5 text-emerald-300">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  保持登录（30 天滚动续期）
                </span>
              ) : (
                '本次登录（关闭浏览器后失效）'
              )
            }
          />
          <InfoRow label="会话到期" value={formatDateTime(session?.expiresAt)} />
          <InfoRow label="有效会话" value={`${credentials?.activeSessions ?? 0} 个`} />
          <InfoRow label="账号最近修改" value={formatDateTime(credentials?.updatedAt)} />
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          密码以 scrypt 哈希保存，会话 token 只保存 SHA-256 摘要；修改凭据后其他设备需要重新登录。
        </p>
      </div>
    </SectionCard>
  );
}
