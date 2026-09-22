import path from 'node:path';

/**
 * Everything that is not a letter, a digit, `.`, `_` or `-`.
 *
 * That covers the Windows-reserved characters (`<>:"/\|?*`), control
 * characters and whitespace in one pass without embedding a literal control
 * character in the pattern.
 */
const ILLEGAL_SEGMENT_CHARS = /[^\p{L}\p{N}._-]+/gu;
/** `CON`, `NUL`, `COM1`… are device names on Windows and cannot be used as a directory name. */
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const MAX_SEGMENT_LENGTH = 160;

/**
 * Normalises a generated id so it can be used as a single path segment.
 *
 * Task ids embed an ISO timestamp, and the `:` in `2026-09-22T11:30:56.073Z`
 * makes `mkdir` fail with `ENOENT` on Windows — the OS reads everything after
 * the colon as an NTFS alternate-data-stream name. Ids are generated
 * filesystem-safe (`idStamp()`), and this helper keeps any already-persisted id
 * from breaking the same way.
 */
export function safePathSegment(value: string, fallback = 'item'): string {
  const trimmed = value
    .replace(ILLEGAL_SEGMENT_CHARS, '-')
    .slice(0, MAX_SEGMENT_LENGTH)
    .replace(/[.-]+$/, '');

  if (trimmed.length === 0) return fallback;
  return RESERVED_DEVICE_NAME.test(trimmed) ? `_${trimmed}` : trimmed;
}

/** Scratch directory a single task writes `prompt.md` / `last-message.md` into. */
export function taskDirectory(dataDir: string, taskId: string): string {
  return path.join(dataDir, 'tasks', safePathSegment(taskId, 'task'));
}
