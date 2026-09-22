import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  applyTheme,
  nextThemeMode,
  type ResolvedTheme,
  readStoredThemeMode,
  resolveTheme,
  storeThemeMode,
  subscribeSystemTheme,
  systemPrefersDark,
  type ThemeMode,
} from '../lib/theme.js';

export interface ThemeContextValue {
  /** Persisted preference; `system` keeps following the OS setting. */
  mode: ThemeMode;
  /** Theme currently applied to the document. */
  theme: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  /** Advances `system → light → dark → system`, used by the header button. */
  cycleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Keeps `<html data-theme>` in sync with the stored preference. The initial
 * value is applied by the pre-paint snippet in `index.html`; this provider only
 * takes over once React renders, so the first paint never flashes.
 */
export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const [mode, setStoredMode] = useState<ThemeMode>(readStoredThemeMode);
  const [prefersDark, setPrefersDark] = useState<boolean>(systemPrefersDark);

  const theme = resolveTheme(mode, prefersDark);

  useEffect(() => subscribeSystemTheme((next) => setPrefersDark(next === 'dark')), []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setMode = useCallback((next: ThemeMode) => {
    setStoredMode(next);
    storeThemeMode(next);
  }, []);

  const cycleMode = useCallback(() => setMode(nextThemeMode(mode)), [mode, setMode]);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, theme, setMode, cycleMode }),
    [mode, theme, setMode, cycleMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme 必须在 ThemeProvider 内部使用');
  return value;
}
