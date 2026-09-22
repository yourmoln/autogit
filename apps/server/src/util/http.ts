import type { ZodType } from 'zod';

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
