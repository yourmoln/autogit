/**
 * Minimal cookie helpers.
 *
 * The login gate needs exactly one cookie (the session token), so AutoGit
 * parses and serializes it by hand instead of pulling in another dependency.
 */

export interface CookieOptions {
  /** `null`/omitted means a browser session cookie. */
  maxAgeSeconds?: number | null;
  path?: string;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  secure?: boolean;
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      result[name] = decodeURIComponent(raw);
    } catch {
      result[name] = raw;
    }
  }

  return result;
}

export function readCookie(header: string | undefined, name: string): string | null {
  return parseCookieHeader(header)[name] ?? null;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);

  if (options.maxAgeSeconds !== undefined && options.maxAgeSeconds !== null) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  if (options.httpOnly ?? true) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.secure) parts.push('Secure');

  return parts.join('; ');
}

export function clearCookie(name: string, options: CookieOptions = {}): string {
  return serializeCookie(name, '', { ...options, maxAgeSeconds: 0 });
}
