import type { QueryClient } from '@tanstack/react-query';

import { logStore, realtime } from './realtime.js';

/** Query cache entry for the current login, kept while protected data is reset. */
export const AUTH_SESSION_KEY = ['auth-session'] as const;

/**
 * Clears every client-side artifact that belongs to a finished login session.
 *
 * Logout and an expired cookie take the same path so protected fetches are
 * cancelled, their cached answers are removed, realtime traffic stops, and the
 * module-level task log store cannot leak lines into the next login.
 */
export async function resetSessionState(queryClient: QueryClient): Promise<void> {
  realtime.stop();
  logStore.clearAll();

  const protectedQueries = {
    predicate: (query: { queryKey: readonly unknown[] }) =>
      query.queryKey[0] !== AUTH_SESSION_KEY[0],
  };
  try {
    await queryClient.cancelQueries(protectedQueries);
  } finally {
    queryClient.removeQueries(protectedQueries);
  }
}
