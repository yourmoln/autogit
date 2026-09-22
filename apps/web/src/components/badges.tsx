import {
  AI_LABEL_BY_NAME,
  labelTitle,
  PROVIDER_META,
  type ProviderKind,
  type TaskKind,
  type TaskPriority,
  type TaskStatus,
} from '@autogit/shared';
import type { ReactNode } from 'react';

import { cn, colorWithAlpha } from '../lib/utils.js';

export function LabelChip({
  name,
  size = 'sm',
  className,
}: {
  name: string;
  size?: 'sm' | 'md';
  className?: string;
}): ReactNode {
  const definition = AI_LABEL_BY_NAME[name];
  const color = definition?.color ?? '6e7781';
  const hex = `#${color}`;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-[10.5px]' : 'px-2.5 py-1 text-xs',
        className,
      )}
      style={{
        borderColor: colorWithAlpha(hex, 0.45),
        background: colorWithAlpha(hex, 0.16),
        color: hex,
      }}
      title={definition?.description ?? name}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: hex }}
        aria-hidden="true"
      />
      {definition ? labelTitle(name) : name}
      <span className="font-mono text-[9.5px] opacity-60">{name}</span>
    </span>
  );
}

export function ProviderBadge({ provider }: { provider: ProviderKind }): ReactNode {
  const meta = PROVIDER_META[provider];
  const tones: Record<ProviderKind, string> = {
    github: 'border-slate-400/30 bg-slate-400/10 text-slate-200',
    gitea: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
    gitee: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
  };
  return <span className={cn('chip', tones[provider])}>{meta?.label ?? provider}</span>;
}

export function TaskStatusBadge({ status }: { status: TaskStatus }): ReactNode {
  const map: Record<TaskStatus, { label: string; className: string; dot: string }> = {
    queued: {
      label: '排队中',
      className: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
      dot: 'bg-amber-300',
    },
    running: {
      label: '运行中',
      className: 'border-indigo-400/40 bg-indigo-400/12 text-indigo-200',
      dot: 'bg-indigo-300',
    },
    succeeded: {
      label: '成功',
      className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
      dot: 'bg-emerald-300',
    },
    failed: {
      label: '失败',
      className: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
      dot: 'bg-rose-300',
    },
    cancelled: {
      label: '已取消',
      className: 'border-slate-400/25 bg-slate-400/10 text-slate-300',
      dot: 'bg-slate-400',
    },
  };
  const tone = map[status];
  return (
    <span className={cn('chip', tone.className)}>
      <span className={cn('inline-block h-1.5 w-1.5 rounded-full', tone.dot)} />
      {tone.label}
    </span>
  );
}

export function TaskKindBadge({ kind }: { kind: TaskKind }): ReactNode {
  const map: Record<TaskKind, { label: string; className: string }> = {
    implement: {
      label: '实现',
      className: 'border-indigo-400/30 bg-indigo-400/10 text-indigo-200',
    },
    review: { label: '评审', className: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200' },
    fix: { label: '修复', className: 'border-orange-400/30 bg-orange-400/10 text-orange-200' },
  };
  return <span className={cn('chip', map[kind].className)}>{map[kind].label}</span>;
}

export function PriorityBadge({ priority }: { priority: TaskPriority }): ReactNode {
  if (priority === 'normal') return null;
  const isHigh = priority === 'high';
  return (
    <span
      className={cn(
        'chip',
        isHigh
          ? 'border-rose-400/30 bg-rose-400/10 text-rose-200'
          : 'border-slate-400/25 bg-slate-400/10 text-slate-300',
      )}
    >
      {isHigh ? '高优先级' : '低优先级'}
    </span>
  );
}

export function EngineBadge({ engine }: { engine: string }): ReactNode {
  return (
    <span className="chip border-violet-400/25 bg-violet-400/10 text-violet-200">
      {engine === 'claude' ? 'Claude' : 'Codex'}
    </span>
  );
}
