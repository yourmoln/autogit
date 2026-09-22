import { AI_LABELS, type AiLabelGroup } from '@autogit/shared';
import { ArrowRight, GitPullRequest, Tags } from 'lucide-react';
import type { ReactNode } from 'react';
import { LabelChip } from '../components/badges.js';
import { SectionCard } from '../components/primitives.js';
import { cn, colorWithAlpha } from '../lib/utils.js';

const GROUP_LABELS: Record<AiLabelGroup, { title: string; description: string }> = {
  'issue-status': { title: 'Issue 状态', description: '单选：Issue 在流水线中的所处阶段' },
  'pr-status': { title: 'PR 状态', description: '单选：Pull Request 的评审阶段' },
  exception: { title: '异常状态', description: '替代状态：流水线暂停，需人工处理后改回有效状态' },
  engine: { title: '执行引擎', description: '可选单选：实现阶段优先使用的引擎' },
  'review-engine': { title: '评审引擎', description: '可选单选：评审阶段优先使用的引擎' },
  priority: { title: '调度优先级', description: '可选单选：构建与评审队列中的排序权重' },
  scheduler: { title: '调度开关', description: '人工暂停，轮询器会跳过该 Issue/PR' },
};

const TRANSITIONS = [
  { from: 'ai/todo', to: 'ai/doing', text: '轮询器领取 Issue，调用 Codex 在隔离工作区实现' },
  { from: 'ai/doing', to: 'ai/in-review', text: '提交并推送分支，创建 PR 后 Issue 转入评审' },
  { from: 'ai/needs-review', to: 'ai/approved', text: 'Codex 评审通过，等待人工合并' },
  { from: 'ai/needs-review', to: 'ai/needs-fix', text: '评审发现问题，自动进入修复队列' },
  { from: 'ai/needs-fix', to: 'ai/needs-review', text: '修复完成后回推分支并重新评审' },
  { from: 'ai/in-review', to: 'ai/verify', text: 'PR 被合并，等待提出人验证后人工关闭' },
  { from: 'ai/doing', to: 'ai/stuck', text: '执行失败、超时或无改动时打阻塞标签并留言' },
] as const;

export function LabelsPage(): ReactNode {
  const groups = Object.keys(GROUP_LABELS) as AiLabelGroup[];

  return (
    <div className="space-y-4">
      <SectionCard
        title="ai/* 标签总览"
        description="AutoGit 只通过这些标签判断状态，所有 AI 动作都由本机 Codex CLI 执行。点击仓库页的「初始化 / 同步标签」即可一次性创建。"
        bodyClassName="grid gap-3 px-4 py-4 lg:grid-cols-2 2xl:grid-cols-3"
      >
        {groups.map((group) => {
          const labels = AI_LABELS.filter((label) => label.group === group);
          return (
            <div
              key={group}
              className="rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-3.5"
            >
              <p className="flex items-center gap-2 text-[12.5px] font-semibold text-slate-100">
                <Tags className="h-3.5 w-3.5 text-indigo-300" />
                {GROUP_LABELS[group].title}
              </p>
              <p className="mt-0.5 text-[10.5px] text-slate-500">
                {GROUP_LABELS[group].description}
              </p>
              <ul className="mt-2.5 space-y-2">
                {labels.map((label) => {
                  const hex = `#${label.color}`;
                  return (
                    <li
                      key={label.name}
                      className="rounded-xl border px-3 py-2"
                      style={{
                        borderColor: colorWithAlpha(hex, 0.25),
                        background: colorWithAlpha(hex, 0.06),
                      }}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <LabelChip name={label.name} />
                        <span className="text-[10.5px] text-slate-500">
                          作用域：
                          {label.scope === 'both'
                            ? 'Issue / PR'
                            : label.scope === 'pr'
                              ? 'PR'
                              : 'Issue'}
                        </span>
                        {label.exclusiveGroup && (
                          <span className="chip border-white/10 text-slate-400">
                            单选组 {label.exclusiveGroup}
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                        {label.description}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </SectionCard>

      <SectionCard
        title="状态流转规则"
        description="调度器每个轮询周期都会重新读取远端标签，标签即状态，不会出现本地与远端不一致的情况。"
        bodyClassName="px-4 py-4"
      >
        <ol className="space-y-2">
          {TRANSITIONS.map((transition, index) => (
            <li
              key={`${transition.from}-${transition.to}`}
              className={cn(
                'flex flex-wrap items-center gap-3 rounded-xl border border-white/8 bg-white/[0.02] px-3.5 py-2.5',
              )}
            >
              <span className="w-6 shrink-0 font-mono text-[11px] text-slate-600">
                {(index + 1).toString().padStart(2, '0')}
              </span>
              <span className="flex items-center gap-2">
                <LabelChip name={transition.from} />
                <ArrowRight className="h-3.5 w-3.5 text-slate-500" />
                <LabelChip name={transition.to} />
              </span>
              <span className="flex-1 text-[11.5px] text-slate-400">{transition.text}</span>
            </li>
          ))}
        </ol>
      </SectionCard>

      <SectionCard
        title="人工介入方式"
        description="任何时候都可以用标签接管流水线"
        bodyClassName="grid gap-3 px-4 py-4 md:grid-cols-3"
      >
        <InterventionCard
          title="暂停"
          label="ai/paused"
          steps="在 Issue 或 PR 上打 ai/paused，调度器会保留当前状态但不再执行任何动作。移除后自动恢复。"
        />
        <InterventionCard
          title="接手卡住的任务"
          label="ai/stuck"
          steps="失败会自动打上 ai/stuck 并留言原因。人工修复后移除 ai/stuck，再打回 ai/todo 或 ai/needs-review 让它继续。"
        />
        <InterventionCard
          title="优先级调度"
          label="ai/priority-high"
          steps="高优先级会插队到构建与评审队列最前面，低优先级则排到末尾，可用于紧急补丁或低价值任务。"
        />
      </SectionCard>

      <SectionCard
        title="评审回路"
        description="评审结论由 Codex 以 JSON Schema 结构化返回，AutoGit 再写回标签与评论。"
        bodyClassName="px-4 py-4"
      >
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-slate-400">
          <GitPullRequest className="h-4 w-4 text-cyan-300" />
          <span className="font-mono text-slate-300">ai/needs-review</span>
          <ArrowRight className="h-3.5 w-3.5" />
          <span>Codex 在 PR 分支上运行评审，输出 verdict / issues / tests</span>
          <ArrowRight className="h-3.5 w-3.5" />
          <span className="font-mono text-emerald-300">ai/approved</span>
          <span className="text-slate-600">或</span>
          <span className="font-mono text-orange-300">ai/needs-fix</span>
        </div>
      </SectionCard>
    </div>
  );
}

function InterventionCard({
  title,
  label,
  steps,
}: {
  title: string;
  label: string;
  steps: string;
}): ReactNode {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-3.5">
      <p className="text-[12.5px] font-semibold text-slate-100">{title}</p>
      <div className="mt-2">
        <LabelChip name={label} size="md" />
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{steps}</p>
    </div>
  );
}
