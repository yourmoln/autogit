/**
 * 固定行高虚拟列表的窗口计算。
 *
 * 任务记录会持续累积，一次性把几百上千行挂到 DOM 里既慢又浪费内存。
 * 这里只做纯函数计算：给定滚动位置和视口高度，算出当前应该渲染的行区间。
 */
export interface VirtualWindow {
  /** 窗口内第一行的下标（含）。 */
  start: number;
  /** 窗口内最后一行的下标（不含）。 */
  end: number;
  /** 窗口相对滚动内容顶部的偏移量（px），用于 translateY。 */
  offset: number;
  /** 全部行的总高度（px），用于撑起滚动条。 */
  totalHeight: number;
}

export const DEFAULT_OVERSCAN = 4;

export function computeVirtualWindow({
  count,
  itemHeight,
  scrollTop,
  viewportHeight,
  overscan = DEFAULT_OVERSCAN,
}: {
  count: number;
  itemHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
}): VirtualWindow {
  const rows = Math.max(0, Math.trunc(count));
  const rowHeight = Math.max(1, itemHeight);
  if (rows === 0) return { start: 0, end: 0, offset: 0, totalHeight: 0 };

  const buffer = Math.max(0, Math.trunc(overscan));
  const viewport = Math.max(0, viewportHeight);
  const totalHeight = rows * rowHeight;
  // 数据变少时滚动位置可能还停在旧高度上，先夹紧再做窗口计算，避免渲染出空白区间。
  const top = Math.min(Math.max(0, scrollTop), Math.max(0, totalHeight - viewport));
  const first = Math.floor(top / rowHeight);
  const visible = Math.max(1, Math.ceil(viewport / rowHeight));

  const start = Math.max(0, first - buffer);
  const end = Math.min(rows, first + visible + buffer);
  return { start, end, offset: start * rowHeight, totalHeight };
}
