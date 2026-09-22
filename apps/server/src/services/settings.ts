import type { AppSettings } from '@autogit/shared';

import type { RuntimeConfig } from '../config.js';
import type { Store } from '../db/store.js';

export function defaultSettings(config: RuntimeConfig): AppSettings {
  return {
    pollSeconds: config.defaultPollSeconds,
    maxConcurrentTasks: config.defaultMaxConcurrent,
    maxConcurrentPerRepo: config.defaultMaxConcurrentPerRepo,
    // Label creation is explicitly triggered from the UI ("初始化"), but users
    // who manage many repositories can switch this on and let polling do it.
    autoInitializeLabels: false,
    autoReview: true,
    autoFix: true,
    allowClaudeFallback: true,
    codexPath: config.codexPathOverride,
    codexModel: null,
    codexSandbox: 'workspace-write',
    codexApprovalPolicy: 'never',
    codexExtraArgs: [],
    commitAuthorName: 'AutoGit Agent',
    commitAuthorEmail: 'autogit@localhost',
    taskTimeoutMinutes: 45,
    branchPrefix: 'ai/issue-',
    labelPrefix: 'ai/',
    prTitleTemplate: '{issueTitle} (#{issueNumber})',
  };
}

const NUMBER_RANGES: Partial<Record<keyof AppSettings, [number, number]>> = {
  pollSeconds: [10, 3600],
  maxConcurrentTasks: [1, 8],
  maxConcurrentPerRepo: [1, 8],
  taskTimeoutMinutes: [5, 240],
};

export class SettingsService {
  private cache: AppSettings | null = null;

  constructor(
    private readonly store: Store,
    private readonly config: RuntimeConfig,
  ) {}

  get(): AppSettings {
    if (this.cache) return this.cache;

    const defaults = defaultSettings(this.config);
    const stored = this.store.allSettings();
    const merged: AppSettings = { ...defaults };

    for (const [key, raw] of Object.entries(stored)) {
      if (!(key in defaults)) continue;
      try {
        const value = JSON.parse(raw) as unknown;
        (merged as unknown as Record<string, unknown>)[key] = value;
      } catch {
        // ignore unparsable rows, defaults win
      }
    }

    this.cache = this.normalize(merged);
    return this.cache;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const current = this.get();
    const next = this.normalize({ ...current, ...patch });
    const payload: Record<string, string> = {};

    for (const [key, value] of Object.entries(next)) {
      payload[key] = JSON.stringify(value);
    }
    this.store.setSettings(payload);
    this.cache = next;
    return next;
  }

  invalidate(): void {
    this.cache = null;
  }

  private normalize(settings: AppSettings): AppSettings {
    const next: AppSettings = { ...settings };

    for (const [key, range] of Object.entries(NUMBER_RANGES)) {
      if (!range) continue;
      const typedKey = key as keyof AppSettings;
      const value = Number(next[typedKey] as number);
      const [min, max] = range;
      next[typedKey] = (
        Number.isFinite(value) ? Math.min(Math.max(value, min), max) : min
      ) as never;
    }

    next.codexExtraArgs = Array.isArray(next.codexExtraArgs)
      ? next.codexExtraArgs.filter(Boolean)
      : [];
    next.codexModel = next.codexModel?.trim() ? next.codexModel.trim() : null;
    next.codexPath = next.codexPath?.trim() ? next.codexPath.trim() : null;
    next.branchPrefix = next.branchPrefix.trim() || 'ai/issue-';
    next.prTitleTemplate = next.prTitleTemplate.trim() || '{issueTitle} (#{issueNumber})';
    next.commitAuthorName = next.commitAuthorName.trim() || 'AutoGit Agent';
    next.commitAuthorEmail = next.commitAuthorEmail.trim() || 'autogit@localhost';

    return next;
  }
}
