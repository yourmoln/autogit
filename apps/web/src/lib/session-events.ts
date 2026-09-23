/**
 * Bridge between the HTTP layer and the auth context.
 *
 * `lib/api.ts` must not import the React context (that would create a cycle),
 * so an expired session is announced through a window event instead.
 */

export const UNAUTHORIZED_EVENT = 'autogit:unauthorized';

export function notifyUnauthorized(): void {
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

export function onUnauthorized(listener: () => void): () => void {
  window.addEventListener(UNAUTHORIZED_EVENT, listener);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, listener);
}
