export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Same instant as `nowIso()`, with `:` and `.` replaced by `-`.
 *
 * Ids end up in branch names, URLs and on-disk directories, and the raw ISO
 * form is not a legal file name on Windows, so generated ids use this variant.
 */
export function idStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function msBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, to - from);
}

export function slugify(input: string, maxLength = 40): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'task';
}
