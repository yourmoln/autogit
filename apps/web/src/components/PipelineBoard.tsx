import { labelDefinition, labelTitle, type TrackedIssue } from '@autogit/shared';
import {
  ExternalLink,
  GitPullRequest,
  Hourglass,
  Play,
  RotateCcw,
  Search,
  Sparkles,
} from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';

import { cn, colorWithAlpha, formatRelative, truncate } from '../lib/utils.js';
import { LabelChip, PriorityBadge } from './badges.js';

export interface PipelineColumn {
  label: string;
  title?: string;
  description?: string;
  items: TrackedIssue[];
  action?: {
    label: string;
    icon: ReactNode;
    onClick: (item: TrackedIssue) => void;
    disabled?: boolean;
  };
}

export function PipelineBoard({
  columns,
  emptyLabel = '暂无匹配的 Issue',
}: {
  columns: PipelineColumn[];
  emptyLabel?: string;
}): ReactNode {
  return (
    <div className="grid gap-3 xl:grid-cols-2 2xl:grid-cols-4">
      {columns.map((column, index) => {
        const definition = labelDefinition(column.label);
        const hex = `#${definition?.color ?? '64748b'}`;
        return (
          <motion.div
            key={column.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.04, duration: 0.24 }}
            className="panel flex min-h-[220px] flex-col overflow-hidden"
          >
            <header
              className="flex items-start justify-between gap-2 px-3.5 py-3"
              style={{
                background: `linear-gradient(180deg, ${colorWithAlpha(hex, 0.16)}, transparent)`,
              }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: hex }} />
                  <p className="text-xs font-semibold text-slate-100">
                    {column.title ?? labelTitle(column.label)}
                  </p>
                  <span className="chip border-white/10 text-slate-300">{column.items.length}</span>
                </div>
                <p className="mt-0.5 text-[10.5px] leading-relaxed text-slate-500">
                  {column.description ?? definition?.description}
                </p>
              </div>
              <span
                className="shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px]"
                style={{ background: colorWithAlpha(hex, 0.18), color: hex }}
              >
                {column.label}
              </span>
            </header>

            <div className="scroll-thin flex-1 space-y-2 overflow-y-auto px-3 py-2.5">
              {column.items.length === 0 ? (
                <p className="rounded-xl border border-dashed border-white/8 px-3 py-6 text-center text-[11px] text-slate-600">
                  {emptyLabel}
                </p>
              ) : (
                column.items.map((item) => (
                  <article
                    key={item.id}
                    className="rounded-xl border border-white/8 bg-white/[0.025] px-3 py-2.5 transition-colors hover:border-white/16 hover:bg-white/5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <a
                        href={item.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 flex-1 text-[12.5px] leading-snug text-slate-200 hover:text-indigo-200"
                      >
                        <span className="text-slate-500">#{item.number} </span>
                        {truncate(item.title, 80)}
                      </a>
                      <a
                        href={item.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-0.5 shrink-0 text-slate-500 hover:text-slate-300"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>

                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      {item.paused && <LabelChip name="ai/paused" />}
                      {item.stuck && <LabelChip name="ai/stuck" />}
                      <PriorityBadge priority={item.priority} />
                      <span className="text-[10px] text-slate-500">@{item.author}</span>
                      <span className="text-[10px] text-slate-600">
                        · {formatRelative(item.updatedAt)}
                      </span>
                    </div>

                    {column.action && (
                      <button
                        type="button"
                        className={cn('btn mt-2 w-full justify-center py-1 text-[11px]')}
                        disabled={column.action.disabled}
                        onClick={() => column.action?.onClick(item)}
                      >
                        {column.action.icon}
                        {column.action.label}
                      </button>
                    )}
                  </article>
                ))
              )}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

export const PIPELINE_ACTION_ICONS = {
  implement: <Play className="h-3.5 w-3.5" />,
  review: <Search className="h-3.5 w-3.5" />,
  fix: <RotateCcw className="h-3.5 w-3.5" />,
  waiting: <Hourglass className="h-3.5 w-3.5" />,
  ai: <Sparkles className="h-3.5 w-3.5" />,
  pr: <GitPullRequest className="h-3.5 w-3.5" />,
} as const;
