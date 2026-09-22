/**
 * Theme preference handling for the console.
 *
 * The preference lives in `localStorage` under `THEME_STORAGE_KEY`. The pre-paint
 * snippet in `index.html` reads the very same key, so the stored value must stay
 * a plain string (`system` | `light` | `dark`).
 */

export const THEME_STORAGE_KEY = 'autogit.theme';

/** What the user picked; `system` follows the OS `prefers-color-scheme` setting. */
export type ThemeMode = 'system' | 'light' | 'dark';

/** What the browser actually renders. */
export type ResolvedTheme = 'light' | 'dark';

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

const DARK_QUERY = '(prefers-color-scheme: dark)';

function darkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

/** Reads the persisted preference, defaulting to `system` when nothing is stored. */
export function readStoredThemeMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : 'system';
  } catch {
    // Storage may be unavailable (private mode); `system` is the default anyway.
    return 'system';
  }
}

/** Persists the preference; `system` is stored as "no preference". */
export function storeThemeMode(mode: ThemeMode): void {
  try {
    if (mode === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Ignore: the choice simply does not survive a reload.
  }
}

/** `true` while the OS asks for a dark appearance. */
export function systemPrefersDark(): boolean {
  const query = darkQuery();
  return query ? query.matches : true;
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode;
  return prefersDark ? 'dark' : 'light';
}

/** Cycle used by the header button: system → light → dark → system. */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  if (mode === 'system') return 'light';
  return mode === 'light' ? 'dark' : 'system';
}

/** Writes the resolved theme onto `<html>`, where the CSS variables pick it up. */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

/** Subscribes to OS appearance changes and returns an unsubscribe function. */
export function subscribeSystemTheme(listener: (theme: ResolvedTheme) => void): () => void {
  const query = darkQuery();
  if (!query) return () => undefined;
  const handle = (event: MediaQueryListEvent): void => listener(event.matches ? 'dark' : 'light');
  query.addEventListener('change', handle);
  return () => query.removeEventListener('change', handle);
}
