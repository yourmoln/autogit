import { AI_LABELS, type LabelPreviewRow } from '@autogit/shared';
import { CircleCheck, Eye, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn, colorWithAlpha } from '../lib/utils.js';
import { SectionCard } from './primitives.js';

export function RepositoryLabelsPanel({
  labels,
  loading,
}: {
  labels: LabelPreviewRow[] | undefined;
  loading: boolean;
}): ReactNode {
  const missing = labels?.filter((label) => label.existsRemotely === false).length ?? 0;

  return (
    <SectionCard
      title="ai/* 标签就绪情况"
      description={
        loading
          ? '正在读取远端标签…'
          : missing > 0
            ? `有 ${missing} 个标签尚未创建，点击「初始化 / 同步标签」补齐`
            : '标签齐备，可以直接给 Issue 打上 ai/todo 开始自动化'
      }
      bodyClassName="space-y-2 px-4 py-3.5"
    >
      {AI_LABELS.map((label) => {
        const remote = labels?.find((item) => item.name === label.name);
        const exists = remote?.existsRemotely;
        const hex = `#${label.color}`;

        return (
          <div
            key={label.name}
            className="flex items-start justify-between gap-3 rounded-xl border px-3 py-2"
            style={{
              borderColor: colorWithAlpha(hex, 0.22),
              background: colorWithAlpha(hex, 0.05),
            }}
          >
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-[12px] text-slate-200">
                <span className="h-2 w-2 rounded-full" style={{ background: hex }} />
                {label.title}
                <span className="font-mono text-[10.5px] text-slate-500">{label.name}</span>
              </p>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-slate-500">
                {label.description}
              </p>
            </div>
            <span
              className={cn(
                'chip shrink-0',
                exists
                  ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
                  : exists === false
                    ? 'border-amber-400/30 bg-amber-400/10 text-amber-200'
                    : 'border-white/10 text-slate-500',
              )}
            >
              {exists ? (
                <CircleCheck className="h-3 w-3" />
              ) : exists === false ? (
                <TriangleAlert className="h-3 w-3" />
              ) : (
                <Eye className="h-3 w-3" />
              )}
              {exists ? '已存在' : exists === false ? '缺失' : '未检查'}
            </span>
          </div>
        );
      })}
    </SectionCard>
  );
}
