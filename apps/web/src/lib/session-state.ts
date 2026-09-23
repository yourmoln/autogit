import type { AuthSessionPayload } from '@autogit/shared';
import type { Query, QueryClient } from '@tanstack/react-query';

import { logStore, realtime } from './realtime.js';
import { onUnauthorized } from './session-events.js';

/** Query cache entry for the current login; the only entry a reset keeps. */
export const AUTH_SESSION_KEY = ['auth-session'] as const;

/** What every page reads once the session is gone, before the server is asked again. */
const ANONYMOUS_SESSION: AuthSessionPayload = {
  authenticated: false,
  session: null,
  credentials: null,
};

/** Every cache entry except the session itself belongs to one login session. */
function isProtectedQuery(query: Query): boolean {
  return query.queryKey[0] !== AUTH_SESSION_KEY[0];
}

/**
 * Clears every client-side artifact that belongs to a finished login session.
 *
 * Logout and an expired cookie take the same path so protected fetches are
 * cancelled, their cached answers are removed, realtime traffic stops, the
 * module-level task log store cannot leak lines into the next login, and the
 * cached session answers "signed out" instead of leaving the tab on the console
 * until something else asks the server again.
 */
export async function resetSessionState(queryClient: QueryClient): Promise<void> {
  queryClient.setQueryData(AUTH_SESSION_KEY, ANONYMOUS_SESSION);
  realtime.stop();
  logStore.clearAll();

  try {
    await queryClient.cancelQueries({ predicate: isProtectedQuery });
  } finally {
    queryClient.removeQueries({ predicate: isProtectedQuery });
  }
}

/**
 * Runs {@link resetSessionState} whenever the session dies under the console's
 * feet.
 *
 * `lib/api.ts` (a protected request answered `401`) and `lib/realtime.ts` (the
 * `4401` close the server sends on logout, expiry, or a credential change made
 * on another device) both announce that through the `autogit:unauthorized`
 * window event. `AuthProvider` registers here, so those two paths cannot drift
 * apart and neither one leaves the previous login's logs or cached pages behind.
 */
export function registerSessionReset(queryClient: QueryClient): () => void {
  return onUnauthorized(() => {
    void resetSessionState(queryClient);
  });
}
