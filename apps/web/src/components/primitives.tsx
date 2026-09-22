import { Check, Copy, LoaderCircle, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { cn, copyText } from '../lib/utils.js';

export function Spinner({ className }: { className?: string }): ReactNode {
  return <LoaderCircle className={cn('h-4 w-4 animate-spin text-slate-400', className)} />;
}

export function Skeleton({ className }: { className?: string }): ReactNode {
  return <div className={cn('skeleton h-4 w-full', className)} />;
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}): ReactNode {
  return (
    <section className={cn('panel overflow-hidden', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
          <div className="min-w-0">
            {title && (
              <h2 className="text-sm font-semibold tracking-tight text-slate-100">{title}</h2>
            )}
            {description && (
              <p className="mt-1 text-xs leading-relaxed text-slate-400">{description}</p>
            )}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="hairline" />
      <div className={cn('px-5 py-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: 'default' | 'brand' | 'success' | 'warning' | 'danger';
}): ReactNode {
  const toneStyles: Record<string, string> = {
    default: 'text-slate-400',
    brand: 'text-indigo-300',
    success: 'text-emerald-300',
    warning: 'text-amber-300',
    danger: 'text-rose-300',
  };

  return (
    <div className="panel panel-hover px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</p>
          <p className="mt-1.5 text-2xl font-semibold tracking-tight text-slate-50">{value}</p>
          {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
        </div>
        {icon && <span className={cn('shrink-0', toneStyles[tone])}>{icon}</span>}
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/10 bg-white/[0.015] px-6 py-10 text-center',
        className,
      )}
    >
      {icon && <div className="text-slate-500">{icon}</div>}
      <p className="text-sm font-medium text-slate-200">{title}</p>
      {description && (
        <p className="max-w-md text-xs leading-relaxed text-slate-400">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div className={cn('block space-y-1.5', className)}>
      <span className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-300">{label}</span>
        {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
      </span>
      {children}
      {error && <span className="block text-[11px] text-rose-400">{error}</span>}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}): ReactNode {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-white/8 bg-white/[0.02] px-3.5 py-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-200">{label}</p>
        {description && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{description}</p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors duration-200 disabled:opacity-40',
          checked
            ? 'border-transparent bg-gradient-to-r from-indigo-500 to-violet-500'
            : 'border-white/12 bg-white/8',
        )}
      >
        <motion.span
          layout
          transition={{ type: 'spring', stiffness: 520, damping: 34 }}
          className={cn(
            'absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow-sm',
            checked ? 'left-[1.55rem]' : 'left-0.5',
          )}
          style={{ height: 18, width: 18 }}
        />
      </button>
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}): ReactNode {
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <button
            type="button"
            aria-label="关闭对话框"
            className="absolute inset-0 cursor-default bg-black/65 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.99 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            className={cn('panel relative z-10 w-full', width)}
          >
            <header className="flex items-start justify-between gap-4 px-5 py-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
                {description && <p className="mt-1 text-xs text-slate-400">{description}</p>}
              </div>
              <button
                type="button"
                className="btn btn-ghost px-2 py-1"
                onClick={onClose}
                aria-label="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="hairline" />
            <div className="scroll-thin max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
            {footer && (
              <>
                <div className="hairline" />
                <footer className="flex items-center justify-end gap-2 px-5 py-3.5">
                  {footer}
                </footer>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function CopyButton({
  value,
  label = '复制',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}): ReactNode {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={cn('btn btn-ghost px-2 py-1 text-[11px]', className)}
      onClick={async () => {
        const ok = await copyText(value);
        if (ok) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
          toast.success('已复制到剪贴板');
        } else {
          toast.error('复制失败，请手动选择内容');
        }
      }}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-400" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {label}
    </button>
  );
}

export function CodeBlock({
  code,
  className,
  maxHeight = 'max-h-80',
}: {
  code: string;
  className?: string;
  maxHeight?: string;
}): ReactNode {
  return (
    <pre
      className={cn(
        'scroll-thin overflow-auto rounded-xl border border-white/8 bg-black/45 p-3 font-mono text-[11.5px] leading-relaxed text-slate-300',
        maxHeight,
        className,
      )}
    >
      {code}
    </pre>
  );
}

export function InfoRow({ label, value }: { label: ReactNode; value: ReactNode }): ReactNode {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/5 py-2 last:border-0">
      <span className="text-[11px] uppercase tracking-wide text-slate-500">{label}</span>
      <span className="max-w-[70%] text-right text-xs text-slate-300">{value}</span>
    </div>
  );
}
