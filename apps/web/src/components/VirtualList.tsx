import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '../lib/utils.js';
import { computeVirtualWindow, DEFAULT_OVERSCAN } from '../lib/virtual.js';

/** 首帧还没量到视口高度时，先按这个高度估算窗口，避免列表空白。 */
const UNMEASURED_VIEWPORT_HEIGHT = 480;

/**
 * 固定行高 + 固定视口高度的虚拟列表。
 *
 * 只把可视区（外加 `overscan` 行缓冲）内的行挂到 DOM 上，行高由 `itemHeight`
 * 统一约定，所以行内容必须能收敛在固定高度内（超出的部分会被裁掉）。
 */
export function VirtualList<T>({
  items,
  itemHeight,
  heightClass = 'h-[26rem]',
  overscan = DEFAULT_OVERSCAN,
  className,
  renderItem,
  getKey,
}: {
  items: readonly T[];
  itemHeight: number;
  /** 固定视口高度类（Tailwind），例如 `h-[26rem]`。 */
  heightClass?: string;
  overscan?: number;
  className?: string;
  renderItem: (item: T, index: number) => ReactNode;
  getKey: (item: T, index: number) => string;
}): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const sync = (): void => setViewportHeight(element.clientHeight);
    sync();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 滚动事件按帧合并，高频滚动时不会每像素触发一次 React 渲染。
  const handleScroll = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      setScrollTop(containerRef.current?.scrollTop ?? 0);
    });
  }, []);

  useEffect(
    () => () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const range = computeVirtualWindow({
    count: items.length,
    itemHeight,
    scrollTop,
    viewportHeight: viewportHeight > 0 ? viewportHeight : UNMEASURED_VIEWPORT_HEIGHT,
    overscan,
  });

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className={cn('scroll-thin overflow-y-auto', heightClass, className)}
    >
      <div className="relative" style={{ height: range.totalHeight }}>
        <ul
          className="absolute inset-x-0 top-0 m-0 list-none p-0"
          style={{ transform: `translateY(${range.offset}px)` }}
        >
          {items.slice(range.start, range.end).map((item, localIndex) => {
            const index = range.start + localIndex;
            return (
              <li
                key={getKey(item, index)}
                aria-setsize={items.length}
                aria-posinset={index + 1}
                className="overflow-hidden"
                style={{ height: itemHeight }}
              >
                {renderItem(item, index)}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
