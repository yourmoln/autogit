import type { ProxySlot, ProxyTestReport } from '@autogit/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.js';
import { HttpError, parseOrThrow } from '../util/http.js';

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  preferred: z.enum(['http', 'socks5', 'direct']).optional(),
  testUrl: z.string().min(1).max(500).optional(),
  gitTestUrl: z.string().min(1).max(500).optional(),
  testTimeoutMs: z.number().int().min(2_000).max(60_000).optional(),
});

/** `null` clears a channel, a string replaces it, an omitted key keeps it. */
const updateSchema = z.object({
  settings: settingsSchema.optional(),
  httpProxy: z.string().max(500).nullable().optional(),
  socks5Proxy: z.string().max(500).nullable().optional(),
});

const testSchema = z.object({
  slots: z.array(z.enum(['http', 'socks5'])).optional(),
  accountId: z.string().min(1).optional(),
  includeGit: z.boolean().optional(),
  timeoutMs: z.number().int().min(2_000).max(60_000).optional(),
  draft: z
    .object({
      httpProxy: z.string().max(500).nullable().optional(),
      socks5Proxy: z.string().max(500).nullable().optional(),
    })
    .optional(),
});

type EndpointBody = Pick<z.infer<typeof updateSchema>, 'httpProxy' | 'socks5Proxy'>;

function endpointsOf(body: EndpointBody): Partial<Record<ProxySlot, string | null>> {
  const endpoints: Partial<Record<ProxySlot, string | null>> = {};
  if (body.httpProxy !== undefined) endpoints.http = body.httpProxy;
  if (body.socks5Proxy !== undefined) endpoints.socks5 = body.socks5Proxy;
  return endpoints;
}

function httpUrlOrThrow(value: string, label: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
    return url.toString();
  } catch {
    throw new HttpError(400, `${label} 必须是 http/https 地址，例如 https://api.github.com/`);
  }
}

export function registerProxyRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/proxy', async () => {
    return { config: ctx.proxy.view() };
  });

  app.put('/api/proxy', async (request) => {
    const body = parseOrThrow(updateSchema, request.body, '代理配置');
    const endpoints = endpointsOf(body);
    const settings = body.settings
      ? {
          ...body.settings,
          ...(body.settings.testUrl
            ? { testUrl: httpUrlOrThrow(body.settings.testUrl, 'REST 测试地址') }
            : {}),
          ...(body.settings.gitTestUrl
            ? { gitTestUrl: httpUrlOrThrow(body.settings.gitTestUrl, 'git 测试地址') }
            : {}),
        }
      : undefined;

    try {
      ctx.proxy.update({ settings, endpoints });
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }

    // Cached provider clients hold the previous proxy, so drop them.
    ctx.providers.clear();
    ctx.events.emit({ type: 'proxy.updated', at: new Date().toISOString() });
    ctx.store.addActivity({
      level: 'info',
      scope: 'proxy',
      repositoryId: null,
      message: ctx.proxy.describeUpdate({ settings, endpoints }),
    });

    return { config: ctx.proxy.view() };
  });

  app.post('/api/proxy/test', async (request) => {
    const body = parseOrThrow(testSchema, request.body, '代理测试');
    let report: ProxyTestReport;

    try {
      report = await ctx.proxy.test({
        slots: body.slots,
        accountId: body.accountId ?? null,
        includeGit: body.includeGit,
        timeoutMs: body.timeoutMs,
        draft: body.draft ? endpointsOf(body.draft) : undefined,
      });
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }

    ctx.store.addActivity({
      level: report.results.some((result) => result.ok) ? 'info' : 'warning',
      scope: 'proxy',
      repositoryId: null,
      message: `代理连通性测试：${report.results
        .map((result) => `${result.label} ${result.ok ? '可用' : '不可用'}`)
        .join('；')}`,
    });

    return { report };
  });
}
