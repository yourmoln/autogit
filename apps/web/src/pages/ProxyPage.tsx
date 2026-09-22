import {
  describeResolvedProxy,
  PROXY_MODE_LABELS,
  PROXY_PREFERENCE_LABELS,
  type ProxyConfigPayload,
  type ProxyMode,
  type ProxyPreference,
  type ProxySettings,
  type ProxySlot,
  type ProxyTestReport,
  parseProxyUrl,
} from '@autogit/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Eraser, Network, RefreshCw, Save, TriangleAlert } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ProviderBadge } from '../components/badges.js';
import {
  EmptyState,
  Field,
  SectionCard,
  Skeleton,
  Spinner,
  Toggle,
} from '../components/primitives.js';
import { api, errorMessage } from '../lib/api.js';
import { cn, formatRelative } from '../lib/utils.js';

const SLOT_FIELD: Record<ProxySlot, 'httpProxy' | 'socks5Proxy'> = {
  http: 'httpProxy',
  socks5: 'socks5Proxy',
};

const SLOT_META: Record<
  ProxySlot,
  { label: string; purpose: string; placeholder: string; example: string }
> = {
  http: {
    label: 'HTTP(S) 代理',
    purpose: 'http:// 走绝对地址转发，https:// 走 CONNECT 隧道（GitHub 走这里）',
    placeholder: 'http://127.0.0.1:7890',
    example: '例如 Clash / v2ray 的混合端口 http://127.0.0.1:7890；https:// 表示到代理本身也走 TLS',
  },
  socks5: {
    label: 'SOCKS5 代理',
    purpose: 'http 与 https 目标都可以走，HTTP(S) 通道留空时会自动回退到它',
    placeholder: 'socks5h://127.0.0.1:1080',
    example: 'socks5h:// 让代理解析域名，避免本地 DNS 被污染',
  },
};

interface EndpointDraft {
  http: string;
  socks5: string;
}

const EMPTY_DRAFT: EndpointDraft = { http: '', socks5: '' };

export function ProxyPage(): ReactNode {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ProxySettings | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [draft, setDraft] = useState<EndpointDraft>(EMPTY_DRAFT);
  const [touched, setTouched] = useState<ProxySlot[]>([]);
  const [report, setReport] = useState<ProxyTestReport | null>(null);
  const [reportTitle, setReportTitle] = useState<string>('');

  const proxy = useQuery({ queryKey: ['proxy'], queryFn: api.proxy.get });

  useEffect(() => {
    if (proxy.data?.config.settings && !settingsDirty) setForm(proxy.data.config.settings);
  }, [proxy.data, settingsDirty]);

  const refresh = (config: ProxyConfigPayload): void => {
    queryClient.setQueryData(['proxy'], { config });
    void queryClient.invalidateQueries({ queryKey: ['accounts'] });
  };

  const save = useMutation({
    mutationFn: () =>
      api.proxy.update({
        settings: form ?? undefined,
        ...(touched.includes('http') ? { httpProxy: draft.http.trim() || null } : {}),
        ...(touched.includes('socks5') ? { socks5Proxy: draft.socks5.trim() || null } : {}),
      }),
    onSuccess: (data) => {
      refresh(data.config);
      setDraft(EMPTY_DRAFT);
      setTouched([]);
      setSettingsDirty(false);
      toast.success('代理配置已保存');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const clearSlot = useMutation({
    mutationFn: (slot: ProxySlot) =>
      api.proxy.update({ [SLOT_FIELD[slot]]: null } as Record<string, null>),
    onSuccess: (data) => {
      refresh(data.config);
      toast.success('已清除该代理通道');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const test = useMutation({
    mutationFn: (input: { slots?: ProxySlot[]; accountId?: string; title: string }) =>
      api.proxy.test({
        slots: input.slots,
        accountId: input.accountId,
        includeGit: true,
        draft: {
          ...(draft.http.trim() ? { httpProxy: draft.http.trim() } : {}),
          ...(draft.socks5.trim() ? { socks5Proxy: draft.socks5.trim() } : {}),
        },
      }),
    onSuccess: (data, input) => {
      setReport(data.report);
      setReportTitle(input.title);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (!form || !proxy.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const config = proxy.data.config;
  const patch = (value: Partial<ProxySettings>): void => {
    setForm({ ...form, ...value });
    setSettingsDirty(true);
  };

  const touch = (slot: ProxySlot, value: string): void => {
    setDraft({ ...draft, [slot]: value });
    setTouched((current) => (current.includes(slot) ? current : [...current, slot]));
  };

  const dirty = settingsDirty || touched.length > 0;

  return (
    <div className="space-y-4">
      <SectionCard
        title="代理总开关"
        description="打开后 AutoGit 的 git 操作、GitHub/Gitea/Gitee 接口请求都会按下面的通道走代理；关闭时全部直连，并忽略系统环境变量里的代理。"
        actions={
          <>
            <button
              type="button"
              className="btn text-[11.5px]"
              disabled={test.isPending}
              onClick={() => test.mutate({ title: '全部通道' })}
            >
              {test.isPending ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Network className="h-3.5 w-3.5" />
              )}
              测试全部通道
            </button>
            <button
              type="button"
              className="btn btn-primary text-[11.5px]"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              保存配置
            </button>
          </>
        }
        bodyClassName="space-y-4"
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <Toggle
            checked={form.enabled}
            onChange={(value) => patch({ enabled: value })}
            label="启用代理"
            description="关闭时所有账号一律直连；账号级别的单独代理同样不会生效。"
          />
          <Field label="默认通道" hint="账号选择「继承全局默认」时使用">
            <select
              className="select"
              value={form.preferred}
              onChange={(event) => patch({ preferred: event.target.value as ProxyPreference })}
            >
              {(Object.keys(PROXY_PREFERENCE_LABELS) as ProxyPreference[]).map((value) => (
                <option key={value} value={value}>
                  {PROXY_PREFERENCE_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-3 text-[11.5px] leading-relaxed text-slate-400">
          <p className="text-[12px] font-medium text-slate-200">
            当前默认通道：{describeResolvedProxy(config.defaultProxy)}
          </p>
          <ul className="mt-2 space-y-1.5">
            <li>
              · 某个通道留空时会自动回退到其它已配置的通道，只填一个地址即可让全部流量走代理。
            </li>
            <li>
              · 地址支持 http://、https://、socks5://、socks5h://，可写 用户名:密码@主机:端口。
            </li>
            <li>· 代理地址会加密保存，页面上只显示掩码；再次填写即覆盖。</li>
          </ul>
        </div>
      </SectionCard>

      <SectionCard
        title="代理服务器"
        description="HTTP(S) 通道同时负责明文 http 与 https 目标；只配置 SOCKS5 也可以，两个通道都能覆盖 GitHub 的 API 与 git 访问。"
        bodyClassName="space-y-4"
      >
        {(Object.keys(SLOT_META) as ProxySlot[]).map((slot) => {
          const summary = config.endpoints[slot];
          const meta = SLOT_META[slot];
          const error = draft[slot].trim() ? proxyInputError(draft[slot]) : null;

          return (
            <div key={slot} className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-[12.5px] font-medium text-slate-200">{meta.label}</p>
                  <p className="mt-0.5 text-[11px] text-slate-500">{meta.purpose}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="btn px-2 py-1 text-[11px]"
                    disabled={test.isPending}
                    onClick={() => test.mutate({ slots: [slot], title: meta.label })}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    测试
                  </button>
                  <button
                    type="button"
                    className="btn px-2 py-1 text-[11px]"
                    disabled={!summary.configured || clearSlot.isPending}
                    onClick={() => clearSlot.mutate(slot)}
                  >
                    <Eraser className="h-3.5 w-3.5" />
                    清除
                  </button>
                </div>
              </div>

              <div className="mt-3">
                <Field
                  label="代理地址"
                  hint={summary.configured ? `已配置：${summary.maskedUrl}` : '未配置'}
                  error={error}
                >
                  <input
                    className="input font-mono text-xs"
                    placeholder={meta.placeholder}
                    value={draft[slot]}
                    onChange={(event) => touch(slot, event.target.value)}
                  />
                </Field>
              </div>
              <p className="mt-2 text-[10.5px] text-slate-500">{meta.example}</p>
            </div>
          );
        })}
      </SectionCard>

      <SectionCard
        title="连通性测试"
        description="每项都会分别请求 GitHub REST API 和执行 git ls-remote，用于确认代理链路真的能拉到代码。"
        actions={
          <span className="text-[11px] text-slate-500">
            {config.updatedAt
              ? `配置更新于 ${formatRelative(config.updatedAt)}`
              : '尚未保存过代理配置'}
          </span>
        }
        bodyClassName="space-y-3"
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="REST 测试地址" hint="默认 api.github.com">
            <input
              className="input font-mono text-[11px]"
              value={form.testUrl}
              onChange={(event) => patch({ testUrl: event.target.value })}
            />
          </Field>
          <Field label="git 测试仓库" hint="执行 git ls-remote">
            <input
              className="input font-mono text-[11px]"
              value={form.gitTestUrl}
              onChange={(event) => patch({ gitTestUrl: event.target.value })}
            />
          </Field>
          <Field label="单次超时（秒）" hint="2 - 60，git 检查最多用 3 倍">
            <input
              type="number"
              className="input"
              min={2}
              max={60}
              value={Math.round(form.testTimeoutMs / 1000)}
              onChange={(event) => patch({ testTimeoutMs: Number(event.target.value) * 1000 })}
            />
          </Field>
        </div>

        {test.isPending ? (
          <div className="flex items-center gap-2 px-1 py-6 text-[12px] text-slate-400">
            <Spinner className="h-4 w-4" />
            正在测试{reportTitle ? ` ${reportTitle}` : ''}…
          </div>
        ) : !report ? (
          <EmptyState
            icon={<Network className="h-5 w-5" />}
            title="还没有测试结果"
            description="点击「测试全部通道」会同时测直连、HTTP(S) 代理与 SOCKS5 代理；未保存的地址也会被使用。"
          />
        ) : (
          <div className="space-y-2">
            {report.results.map((result) => (
              <div
                key={`${result.target}-${result.label}`}
                className="rounded-xl border border-white/8 bg-white/[0.02] px-3.5 py-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-[12.5px] text-slate-200">
                    <span
                      className={cn(
                        'chip',
                        result.ok
                          ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
                          : 'border-rose-400/30 bg-rose-400/10 text-rose-200',
                      )}
                    >
                      {result.ok ? (
                        <CircleCheck className="h-3 w-3" />
                      ) : (
                        <TriangleAlert className="h-3 w-3" />
                      )}
                      {result.ok ? '可用' : '不可用'}
                    </span>
                    {result.label}
                  </span>
                  {result.maskedUrl && (
                    <span className="font-mono text-[10.5px] text-slate-500">
                      {result.maskedUrl}
                    </span>
                  )}
                </div>

                <div className="mt-2 space-y-1">
                  {result.checks.map((check) => (
                    <div
                      key={check.id}
                      className="flex flex-wrap items-baseline justify-between gap-2 text-[11.5px]"
                    >
                      <span className="text-slate-400">
                        {check.ok ? '✓' : '✗'} {check.label}
                        {check.status !== null ? ` · HTTP ${check.status}` : ''}
                        {check.latencyMs !== null ? ` · ${check.latencyMs}ms` : ''}
                      </span>
                      {check.message && (
                        <span className="max-w-full text-slate-500 sm:max-w-[60%] sm:text-right">
                          {check.message}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <p className="px-1 text-[10.5px] text-slate-500">
              用时 {report.durationMs}ms · {formatRelative(report.finishedAt)}
            </p>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="账号代理"
        description="默认所有账号跟随全局配置；如果某个账号需要走不同的出口（例如自建 Gitea 直连、GitHub 走代理），在这里单独指定。"
        bodyClassName="space-y-2"
      >
        {config.accounts.length === 0 ? (
          <EmptyState
            icon={<Network className="h-5 w-5" />}
            title="还没有 Git 账号"
            description="先在「Git 账号」页面添加账号，然后就能为它单独指定代理。"
          />
        ) : (
          config.accounts.map((account) => (
            <AccountProxyRow
              key={account.id}
              account={account}
              onSaved={refresh}
              onTest={() =>
                test.mutate({ accountId: account.id, title: `账号「${account.name}」` })
              }
              testing={test.isPending}
            />
          ))
        )}
      </SectionCard>
    </div>
  );
}

function AccountProxyRow({
  account,
  onSaved,
  onTest,
  testing,
}: {
  account: ProxyConfigPayload['accounts'][number];
  onSaved: (config: ProxyConfigPayload) => void;
  onTest: () => void;
  testing: boolean;
}): ReactNode {
  const [mode, setMode] = useState<ProxyMode>(account.proxyMode);
  const [url, setUrl] = useState('');
  const [dirty, setDirty] = useState(false);
  const [synced, setSynced] = useState(accountState(account));

  // React's "adjust state when props change" pattern: after a save (or when
  // another tab changes the account) the server state changes and the local
  // draft has to be dropped.
  const state = accountState(account);
  if (state !== synced) {
    setSynced(state);
    setMode(account.proxyMode);
    setUrl('');
    setDirty(false);
  }

  const save = useMutation({
    mutationFn: () =>
      api.accounts.update(account.id, {
        proxyMode: mode,
        verify: false,
        // Only send an address when the user typed one: existing credentials
        // stay untouched otherwise.
        ...(mode === 'custom' && url.trim() ? { proxyUrl: url.trim() } : {}),
      }),
    onSuccess: async () => {
      toast.success(`账号「${account.name}」的代理已更新`);
      const refreshed = await api.proxy.get();
      onSaved(refreshed.config);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const error = mode === 'custom' && url.trim() ? proxyInputError(url) : null;

  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.02] px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[12.5px] text-slate-200">
          <ProviderBadge provider={account.provider} />
          {account.name}
        </span>
        <span className="text-[11px] text-slate-500">
          当前：{describeResolvedProxy(account.effective)}
        </span>
      </div>

      <div className="mt-2.5 grid gap-2 lg:grid-cols-[minmax(0,220px)_minmax(0,1fr)_auto]">
        <select
          className="select"
          value={mode}
          onChange={(event) => {
            setMode(event.target.value as ProxyMode);
            setDirty(true);
          }}
        >
          {(Object.keys(PROXY_MODE_LABELS) as ProxyMode[]).map((value) => (
            <option key={value} value={value}>
              {PROXY_MODE_LABELS[value]}
            </option>
          ))}
        </select>

        {mode === 'custom' ? (
          <input
            className={cn('input font-mono text-xs', error && 'border-rose-400/40')}
            placeholder={
              account.proxyMaskedUrl ?? 'socks5h://127.0.0.1:1080 或 http://127.0.0.1:7890'
            }
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setDirty(true);
            }}
          />
        ) : (
          <span className="self-center text-[11px] text-slate-500">
            {mode === 'inherit' ? '跟随上方「默认通道」' : PROXY_MODE_LABELS[mode]}
          </span>
        )}

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="btn px-2 py-1 text-[11px]"
            disabled={testing}
            onClick={onTest}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', testing && 'animate-spin')} />
            测试
          </button>
          <button
            type="button"
            className="btn btn-primary px-2 py-1 text-[11px]"
            disabled={!dirty || save.isPending || Boolean(error)}
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <Spinner className="h-3.5 w-3.5" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            保存
          </button>
        </div>
      </div>

      {account.proxyMaskedUrl && mode === 'custom' && (
        <p className="mt-1.5 text-[10.5px] text-slate-500">
          已保存：{account.proxyMaskedUrl}（留空并保存不会覆盖）
        </p>
      )}
      {error && <p className="mt-1.5 text-[10.5px] text-rose-400">{error}</p>}
    </div>
  );
}

/** Shared validation so the UI rejects bad addresses before the request. */
function proxyInputError(value: string): string | null {
  try {
    parseProxyUrl(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Identity of the server side proxy state of one account row. */
function accountState(account: ProxyConfigPayload['accounts'][number]): string {
  return `${account.proxyMode}|${account.proxyMaskedUrl ?? ''}`;
}
