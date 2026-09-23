import { Monitor, Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';

import { useTheme } from '../hooks/useTheme.js';
import { nextThemeMode, type ThemeMode } from '../lib/theme.js';

const MODE_META: Record<ThemeMode, { label: string; hint: string; icon: typeof Sun }> = {
  system: { label: '跟随系统', hint: '跟随系统外观', icon: Monitor },
  light: { label: '浅色', hint: '始终使用浅色主题', icon: Sun },
  dark: { label: '深色', hint: '始终使用深色主题', icon: Moon },
};

/** Header button cycling `跟随系统 → 浅色 → 深色`; the choice is persisted locally. */
export function ThemeToggle(): ReactNode {
  const { mode, cycleMode } = useTheme();
  const current = MODE_META[mode];
  const next = MODE_META[nextThemeMode(mode)];
  const Icon = current.icon;

  return (
    <button
      type="button"
      className="btn gap-1.5 px-2.5 py-1.5 text-[11px]"
      onClick={cycleMode}
      title={`${current.hint}（点击切换为${next.label}）`}
      aria-label={`切换主题，当前${current.label}`}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">{current.label}</span>
    </button>
  );
}
