import type { ZodType } from 'zod';

/** Prefix of every JSON endpoint; static assets and the SPA stay outside of it. */
export const API_PREFIX = '/api';

/**
 * Percent-decodes the path part of a request URL.
 *
 * The router (`find-my-way`) matches routes against the *decoded* path, while
 * `request.url` still carries the raw bytes, so `/%61pi/system/overview` reaches
 * the `/api/system/overview` handler. Any string comparison on a path — the auth
 * guard above all — has to decode first, otherwise the encoded spelling walks
 * straight past the check.
 */
export function decodeRequestPath(url: string): string {
  const raw = url.split('?')[0] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    // Malformed escapes (`/%zz`) never match a route; keep the raw form.
    return raw;
  }
}

/** `true` for the API prefix itself and everything below it. */
export function isApiPath(path: string): boolean {
  return path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
}

export class HttpError extends Error {
  readonly statusCode: number;
  readonly details: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function parseOrThrow<T>(schema: ZodType<T>, value: unknown, what = '请求体'): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('；');
  throw new HttpError(400, `${what}校验失败：${details}`);
}

export function notFound(message: string): never {
  throw new HttpError(404, message);
}

export function badRequest(message: string): never {
  throw new HttpError(400, message);
}
