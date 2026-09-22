/**
 * One place that performs outgoing HTTP requests: the platform `fetch` for a
 * direct connection, and the proxy aware client when AutoGit has a proxy for
 * the target.
 */
import { ProxyRequestError, requestViaProxy } from './proxy-http.js';

export interface TextRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
  /** `null`/`undefined` connects directly. */
  proxyUrl?: string | null;
}

export interface TextResponse {
  status: number;
  /** Lower cased header names. */
  headers: Record<string, string>;
  body: string;
}

export async function requestText(input: TextRequestInput): Promise<TextResponse> {
  const timeoutMs = input.timeoutMs ?? 30_000;

  if (input.proxyUrl) {
    const response = await requestViaProxy({
      url: input.url,
      method: input.method,
      headers: input.headers,
      body: input.body ?? null,
      timeoutMs,
      proxyUrl: input.proxyUrl,
    });
    return { status: response.status, headers: response.headers, body: response.body };
  }

  const response = await fetch(input.url, {
    method: input.method ?? 'GET',
    headers: input.headers,
    body: input.body ?? undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: response.status, headers, body: await response.text() };
}

/**
 * Turns fetch / proxy failures into a single readable Chinese line. `fetch`
 * hides the real reason in `error.cause`, which is exactly what users need
 * (`ENOTFOUND`, `ECONNREFUSED`, …).
 */
export function describeNetworkError(error: unknown, timeoutMs?: number): string {
  if (error instanceof ProxyRequestError) return error.message;
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeText =
      cause instanceof Error
        ? `${cause.message}${describeCauseCode(cause)}`
        : typeof cause === 'string'
          ? cause
          : '';
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return timeoutMs ? `请求超时（${Math.round(timeoutMs / 1000)}s）` : '请求超时';
    }
    const base = error.message || error.name;
    if (causeText && !base.includes(causeText)) return `${base}（${causeText}）`;
    return base;
  }
  return String(error);
}

function describeCauseCode(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && !error.message.includes(code) ? ` [${code}]` : '';
}

/** Pulls the provider supplied message out of an error body, for the UI. */
export function responseDetail(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      for (const key of ['message', 'error_description', 'error', 'detail']) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0) return truncate(value);
      }
    }
  } catch {
    // not JSON, use the raw text below
  }
  if (/^\s*<!doctype html/i.test(trimmed) || /^\s*<html/i.test(trimmed)) {
    return '代理/网关返回了 HTML 页面（通常表示代理需要认证或目标被拦截）';
  }
  return truncate(trimmed);
}

function truncate(value: string, max = 240): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}
