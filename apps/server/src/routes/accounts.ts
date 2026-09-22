import { type Account, PROVIDER_META, type ProviderKind } from '@autogit/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.js';
import type { AccountRecord } from '../db/store.js';
import { describeProviderError } from '../services/providers.js';
import { maskSecret, randomId } from '../util/crypto.js';
import { HttpError, parseOrThrow } from '../util/http.js';

const createSchema = z.object({
  name: z.string().min(1, '账号名称不能为空').max(80),
  provider: z.enum(['github', 'gitea', 'gitee']),
  baseUrl: z.string().min(1).optional(),
  token: z.string().min(8, 'Token 看起来太短'),
  verify: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  baseUrl: z.string().min(1).optional(),
  token: z.string().min(8).optional(),
  verify: z.boolean().optional(),
});

function defaultBaseUrl(provider: ProviderKind, baseUrl?: string): string {
  if (baseUrl && baseUrl.trim().length > 0) return baseUrl.trim();
  const meta = PROVIDER_META[provider];
  if (!meta.defaultBaseUrl) {
    throw new HttpError(400, `${meta.label} 需要填写实例地址，例如 https://git.example.com`);
  }
  return meta.defaultBaseUrl;
}

function serializeAccount(account: AccountRecord, ctx: AppContext): Account {
  let tokenPreview: string | null = null;
  try {
    tokenPreview = maskSecret(ctx.providers.decrypt(account.tokenEnc));
  } catch {
    tokenPreview = '无法解密';
  }
  const { tokenEnc: _tokenEnc, ...rest } = account;
  return { ...rest, tokenPreview };
}

export function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/accounts', async () => {
    return {
      items: ctx.store.listAccounts().map((account) => serializeAccount(account, ctx)),
      providers: PROVIDER_META,
    };
  });

  app.post('/api/accounts', async (request, reply) => {
    const body = parseOrThrow(createSchema, request.body, '账号信息');
    const baseUrl = defaultBaseUrl(body.provider, body.baseUrl);
    const provider = ctx.providers.create({
      provider: body.provider,
      baseUrl,
      username: null,
      token: body.token,
    });

    let username: string | null = null;
    let displayName: string | null = null;
    let avatarUrl: string | null = null;
    let status: Account['status'] = 'unknown';
    let statusMessage: string | null = null;

    if (body.verify !== false) {
      try {
        const user = await provider.getCurrentUser();
        username = user.login;
        displayName = user.name;
        avatarUrl = user.avatarUrl;
        status = 'ok';
        statusMessage = `已验证：@${user.login}`;
      } catch (error) {
        throw new HttpError(400, `连接验证失败：${describeProviderError(error)}`);
      }
    }

    const account = ctx.store.createAccount({
      id: randomId('acc'),
      name: body.name,
      provider: body.provider,
      baseUrl,
      tokenEnc: ctx.providers.encrypt(body.token),
      username,
      displayName,
      avatarUrl,
      status,
      statusMessage,
    });
    ctx.providers.invalidate(account.id);
    ctx.events.emit({ type: 'account.updated', accountId: account.id });
    ctx.store.addActivity({
      level: 'success',
      scope: 'account',
      repositoryId: null,
      message: `新增账号「${account.name}」（${PROVIDER_META[account.provider].label}）`,
    });

    return reply.code(201).send({ account: serializeAccount(account, ctx) });
  });

  app.patch('/api/accounts/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(updateSchema, request.body, '账号信息');
    const existing = ctx.store.getAccount(id);
    if (!existing) throw new HttpError(404, '账号不存在');

    const patch: Parameters<typeof ctx.store.updateAccount>[1] = {};
    if (body.name) patch.name = body.name;
    if (body.baseUrl) patch.baseUrl = body.baseUrl.trim();
    if (body.token) patch.tokenEnc = ctx.providers.encrypt(body.token);

    const needsVerify = Boolean(body.token || body.baseUrl) && body.verify !== false;
    if (needsVerify) {
      const provider = ctx.providers.create({
        provider: existing.provider,
        baseUrl: patch.baseUrl ?? existing.baseUrl,
        username: existing.username,
        token: body.token ?? ctx.providers.decrypt(existing.tokenEnc),
      });
      try {
        const user = await provider.getCurrentUser();
        patch.username = user.login;
        patch.displayName = user.name;
        patch.avatarUrl = user.avatarUrl;
        patch.status = 'ok';
        patch.statusMessage = `已验证：@${user.login}`;
      } catch (error) {
        throw new HttpError(400, `连接验证失败：${describeProviderError(error)}`);
      }
    }

    const updated = ctx.store.updateAccount(id, patch);
    if (!updated) throw new HttpError(404, '账号不存在');
    ctx.providers.invalidate(id);
    ctx.events.emit({ type: 'account.updated', accountId: id });
    return { account: serializeAccount(updated, ctx) };
  });

  app.delete('/api/accounts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = ctx.store.getAccount(id);
    if (!account) throw new HttpError(404, '账号不存在');
    ctx.store.deleteAccount(id);
    ctx.providers.invalidate(id);
    ctx.events.emit({ type: 'account.updated', accountId: id });
    ctx.store.addActivity({
      level: 'warning',
      scope: 'account',
      repositoryId: null,
      message: `删除账号「${account.name}」及其 ${account.repositoryCount} 个仓库配置`,
    });
    return reply.code(204).send();
  });

  app.post('/api/accounts/:id/test', async (request) => {
    const { id } = request.params as { id: string };
    const account = ctx.store.getAccount(id);
    if (!account) throw new HttpError(404, '账号不存在');

    const provider = ctx.providers.create({
      provider: account.provider,
      baseUrl: account.baseUrl,
      username: account.username,
      token: ctx.providers.decrypt(account.tokenEnc),
    });

    try {
      const user = await provider.getCurrentUser();
      ctx.store.updateAccount(id, {
        username: user.login,
        displayName: user.name,
        avatarUrl: user.avatarUrl,
      });
      ctx.store.markAccountChecked(id, 'ok', `已验证：@${user.login}`);
      ctx.providers.invalidate(id);
      return { ok: true, user };
    } catch (error) {
      const message = describeProviderError(error);
      ctx.store.markAccountChecked(id, 'error', message);
      ctx.events.emit({ type: 'account.updated', accountId: id });
      return { ok: false, error: message };
    }
  });

  app.get('/api/accounts/:id/repositories', async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { page?: string; perPage?: string; search?: string };
    const account = ctx.store.getAccount(id);
    if (!account) throw new HttpError(404, '账号不存在');

    const provider = ctx.providers.forAccount(id);
    const page = Number.parseInt(query.page ?? '1', 10) || 1;
    const perPage = Math.min(Number.parseInt(query.perPage ?? '50', 10) || 50, 100);

    const imported = new Map(
      ctx.store
        .listRepositories()
        .filter((repository) => repository.accountId === id)
        .map((repository) => [repository.fullName.toLowerCase(), repository.id]),
    );

    try {
      const result = await provider.listRepositories({ page, perPage, search: query.search });
      return {
        page: result.page,
        hasMore: result.hasMore,
        items: result.items.map((item) => ({
          ...item,
          imported: imported.has(item.fullName.toLowerCase()),
          repositoryId: imported.get(item.fullName.toLowerCase()) ?? null,
        })),
      };
    } catch (error) {
      throw new HttpError(502, `获取仓库列表失败：${describeProviderError(error)}`);
    }
  });
}
