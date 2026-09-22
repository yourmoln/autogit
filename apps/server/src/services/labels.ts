import {
  AI_LABELS,
  describeLabelCoverage,
  type LabelPreviewRow,
  type LabelSyncResult,
} from '@autogit/shared';

import type { RepositoryRecord, Store } from '../db/store.js';
import type { GitProvider, RepoRef } from '../providers/index.js';
import { childLogger } from '../util/logger.js';
import { nowIso } from '../util/time.js';
import type { EventBus } from './events.js';
import { describeProviderError, type ProviderFactory } from './providers.js';

export interface LabelServiceDeps {
  store: Store;
  providers: ProviderFactory;
  events: EventBus;
}

function normalizeColor(value: string | null | undefined): string {
  return (value ?? '').replace(/^#/, '').toLowerCase();
}

/**
 * Creates and keeps the `ai/*` label catalogue in sync with a repository.
 * The operation is idempotent: existing labels are only touched when their
 * colour or description drifted.
 */
export class LabelService {
  private readonly log = childLogger('labels');

  constructor(private readonly deps: LabelServiceDeps) {}

  private ref(repository: RepositoryRecord): RepoRef {
    return { owner: repository.owner, name: repository.name };
  }

  async preview(repository: RepositoryRecord): Promise<LabelPreviewRow[]> {
    const provider = this.deps.providers.forAccount(repository.accountId);
    let remote: Set<string> | null = null;
    try {
      const labels = await provider.listLabels(this.ref(repository));
      remote = new Set(labels.map((label) => label.name));
    } catch (error) {
      this.log.warn({ err: error, repository: repository.fullName }, 'label preview failed');
    }

    return AI_LABELS.map((label) => ({
      ...label,
      existsRemotely: remote ? remote.has(label.name) : null,
    }));
  }

  async initialize(repository: RepositoryRecord): Promise<LabelSyncResult> {
    const provider = this.deps.providers.forAccount(repository.accountId);
    return this.sync(provider, repository);
  }

  async sync(provider: GitProvider, repository: RepositoryRecord): Promise<LabelSyncResult> {
    const ref = this.ref(repository);
    const result: LabelSyncResult = {
      created: [],
      updated: [],
      unchanged: [],
      failed: [],
      syncedAt: nowIso(),
    };

    let existing: Map<string, { color: string; description: string | null }>;
    try {
      const labels = await provider.listLabels(ref);
      existing = new Map(
        labels.map((label) => [label.name, { color: label.color, description: label.description }]),
      );
    } catch (error) {
      const message = describeProviderError(error);
      result.failed.push({ name: '*', error: `读取标签失败：${message}` });
      this.deps.store.updateRepository(repository.id, { lastPollError: message });
      return result;
    }

    for (const label of AI_LABELS) {
      const current = existing.get(label.name);
      const payload = {
        name: label.name,
        color: label.color,
        description: label.description,
        exclusive: label.exclusiveGroup !== undefined,
      };

      try {
        if (!current) {
          await provider.createLabel(ref, payload);
          result.created.push(label.name);
          continue;
        }
        const colorMatches = normalizeColor(current.color) === normalizeColor(label.color);
        const descriptionMatches = (current.description ?? '').trim() === label.description;
        if (colorMatches && descriptionMatches) {
          result.unchanged.push(label.name);
          continue;
        }
        await provider.updateLabel(ref, label.name, payload);
        result.updated.push(label.name);
      } catch (error) {
        result.failed.push({ name: label.name, error: describeProviderError(error) });
      }
    }

    const coverage = describeLabelCoverage([...existing.keys()]);
    this.deps.store.updateRepository(repository.id, {
      labelsInitialized: result.failed.length === 0,
      labelSyncedAt: result.syncedAt,
      lastPollError:
        result.failed.length > 0 ? `标签同步部分失败：${result.failed.length} 个` : null,
    });
    this.deps.events.emit({ type: 'repository.updated', repositoryId: repository.id });
    this.deps.store.addActivity({
      level: result.failed.length === 0 ? 'success' : 'warning',
      scope: 'labels',
      repositoryId: repository.id,
      message: `标签初始化完成：新建 ${result.created.length}，更新 ${result.updated.length}，跳过 ${result.unchanged.length}，失败 ${result.failed.length}（仓库原有标签 ${coverage.present}/${coverage.total} 已存在）`,
    });

    return result;
  }
}
