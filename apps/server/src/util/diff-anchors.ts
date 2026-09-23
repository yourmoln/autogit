/**
 * Index of the lines a review comment may be anchored to.
 *
 * Every supported platform can attach a comment to a line of the change, but
 * each one addresses that line differently: GitHub wants the line number of the
 * new file version (`line` + `side=RIGHT`), Gitea the same number in a field
 * named `new_position`, Gitee a position inside the patch. All of them reject a
 * line that is not part of the diff (or silently anchor the comment elsewhere),
 * so the orchestrator resolves every finding against this index first and keeps
 * the findings it cannot anchor inside the summary comment.
 */
export interface DiffAnchor {
  /** Repository relative path, with the `a/` / `b/` prefix removed. */
  path: string;
  /** Line number in the new version of the file. */
  line: number;
  /**
   * Candidate indexes of that line inside the patch of its file, most likely
   * reading first.
   *
   * GitHub documents the position as "the number of lines down from the first
   * `@@` hunk header", so the line right below the first header is 1 and the
   * count keeps increasing through the rest of the file, the headers of the
   * later hunks included: review comments on real multi hunk files sit exactly
   * one number higher per preceding header. Deployments that leave those
   * headers out only differ from the second hunk on, so both readings travel
   * together and a provider that addresses a line by patch position tries them
   * in order.
   */
  diffPositions: readonly number[];
}

export interface DiffAnchors {
  /** Path -> the anchorable lines of that file. */
  readonly files: Map<string, FilePatchLines>;
  /** Resolves a `file` / `line` pair produced by the model into an anchor. */
  find(file: string | null | undefined, line: number | null | undefined): DiffAnchor | null;
}

/** New file line -> index inside the patch, under both readings of `position`. */
interface FilePatchLines {
  /** Counted the way GitHub documents it: later hunk headers consume an index. */
  readonly withHeaders: Map<number, number>;
  /** Counted without any hunk header line. */
  readonly withoutHeaders: Map<number, number>;
}

/** `@@ -oldStart,oldCount +newStart,newCount @@ [context]` (counts may be omitted). */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiffAnchors(diff: string): DiffAnchors {
  const files = new Map<string, FilePatchLines>();
  let path: string | null = null;
  let lines: FilePatchLines | null = null;
  // Both readings start at 1 on the first line below the file's first `@@`;
  // every hunk header after that one adds a line to the documented reading only.
  let withHeaders = 0;
  let withoutHeaders = 0;
  let hunks = 0;
  let newLine = 0;
  let remainingOld = 0;
  let remainingNew = 0;
  let inHunk = false;

  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      path = null;
      lines = null;
      inHunk = false;
      hunks = 0;
      withHeaders = 0;
      withoutHeaders = 0;
      continue;
    }

    if (inHunk) {
      const marker = raw.charAt(0);
      // "\ No newline at end of file" is not a line of the file and does not
      // consume an index either - GitHub's own `patch` field omits it as well.
      if (marker === '\\') continue;
      withHeaders += 1;
      withoutHeaders += 1;
      if (marker === '+') {
        lines?.withHeaders.set(newLine, withHeaders);
        lines?.withoutHeaders.set(newLine, withoutHeaders);
        newLine += 1;
        remainingNew -= 1;
      } else if (marker === '-') {
        remainingOld -= 1;
      } else {
        // A context line exists in both versions of the file.
        lines?.withHeaders.set(newLine, withHeaders);
        lines?.withoutHeaders.set(newLine, withoutHeaders);
        newLine += 1;
        remainingOld -= 1;
        remainingNew -= 1;
      }
      if (remainingOld <= 0 && remainingNew <= 0) inHunk = false;
      continue;
    }

    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      hunks += 1;
      // Only the first header of a file is free: the line below it is position
      // 1, but every further header is one more line of the file patch.
      if (hunks > 1) withHeaders += 1;
      newLine = Number(hunk[3]);
      remainingOld = hunk[2] === undefined ? 1 : Number(hunk[2]);
      remainingNew = hunk[4] === undefined ? 1 : Number(hunk[4]);
      inHunk = true;
      if (path) {
        lines = files.get(path) ?? { withHeaders: new Map(), withoutHeaders: new Map() };
        files.set(path, lines);
      }
      continue;
    }

    // Only read this outside of a hunk: an added line whose content starts with
    // `++ ` renders as `+++ ...` and would look like a file header. The `---`
    // line next to it is ignored on purpose - a deleted file has no new side to
    // comment on, so only `+++` decides whether a section is anchorable.
    if (raw.startsWith('+++ ')) {
      path = stripPrefix(parseDiffSpec(raw.slice(4)));
      lines = null;
    }
  }

  return {
    files,
    find(file, line) {
      if (!file || line === null || line === undefined) return null;
      if (!Number.isInteger(line) || line < 1) return null;

      // An absolute path carries directories the diff cannot know about, so the
      // tail of such a path may match a diff path (see `resolvePath`).
      const absolute = isAbsolutePath(file);
      for (const candidate of pathCandidates(file)) {
        const resolved = resolvePath(files, candidate, absolute);
        if (!resolved) continue;
        const diffPositions = anchorAt(files.get(resolved), line);
        if (diffPositions) return { path: resolved, line, diffPositions };
      }
      return null;
    },
  };
}

/** `b/src/x.ts` / `"b/src/x y.ts"` / `/dev/null` as written in a patch header. */
function parseDiffSpec(spec: string): string | null {
  const raw = spec.trim();
  const value =
    raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
      ? decodeQuotedPath(raw.slice(1, -1))
      : raw;
  if (!value || value === '/dev/null') return null;
  return value;
}

/** The C style escapes git may write inside a quoted path (see git's `quote.c`). */
const QUOTED_PATH_ESCAPES: Record<string, string> = {
  a: '\u0007',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '"': '"',
  '\\': '\\',
};

/**
 * Decodes a quoted path the way git wrote it: `"` and `\` are escaped, so are
 * control characters, and - while `core.quotePath` keeps its default - every
 * non ASCII byte as `\OOO`. Those octal escapes are UTF-8 bytes, so they have to
 * be collected as bytes and decoded together with the literal characters;
 * otherwise a repository with Chinese file names never resolves an anchor.
 * AutoGit asks git for raw paths (`core.quotePath=false`), so this is the second
 * line of defence for patches produced with the default setting.
 */
function decodeQuotedPath(quoted: string): string {
  const bytes: number[] = [];
  const push = (text: string): void => {
    for (const byte of Buffer.from(text, 'utf8')) bytes.push(byte);
  };

  for (let index = 0; index < quoted.length; index += 1) {
    const char = quoted.charAt(index);
    if (char !== '\\') {
      push(char);
      continue;
    }

    const octal = /^[0-7]{3}/.exec(quoted.slice(index + 1))?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }

    const next = quoted.charAt(index + 1);
    push(QUOTED_PATH_ESCAPES[next] ?? next);
    index += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Drops the `a/` / `b/` prefix git puts in front of every diff path. */
function stripPrefix(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/^[ab]\//, '');
}

/**
 * The indexes of `line` inside one file patch, most likely reading first, or
 * `null` when the line is not part of that patch.
 */
function anchorAt(lines: FilePatchLines | undefined, line: number): number[] | null {
  const withHeaders = lines?.withHeaders.get(line);
  if (withHeaders === undefined) return null;
  const withoutHeaders = lines?.withoutHeaders.get(line);
  if (withoutHeaders === undefined || withoutHeaders === withHeaders) return [withHeaders];
  return [withHeaders, withoutHeaders];
}

/**
 * Paths the model realistically writes: an absolute one, a `./` prefixed one,
 * or a copy of the diff header (`b/src/x.ts`). The raw value is tried first so
 * a repository that really has a file called `a/x.ts` still resolves.
 */
function pathCandidates(file: string): string[] {
  const raw = file.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const cleaned = raw.replace(/^\.\//, '');
  const stripped = cleaned.replace(/^[ab]\//, '');
  return [...new Set([raw, cleaned, stripped].filter((value) => value.length > 0))];
}

/** `true` for `/abs/x.ts`, `C:\abs\x.ts` and `C:/abs/x.ts`. */
function isAbsolutePath(file: string): boolean {
  const value = file.trim();
  return /^[/\\]/.test(value) || /^[A-Za-z]:[/\\]/.test(value);
}

/**
 * The single diff path `candidate` refers to, or `null` when it is ambiguous.
 *
 * Next to an exact match two shapes are accepted: the model dropped leading
 * directories (`src/x.ts` for `apps/web/src/x.ts`), and - for a path the model
 * wrote as an absolute one - the diff path is the tail of it, since the
 * directories above the repository root cannot be known here.
 *
 * A relative path that *adds* directories is deliberately left unresolved: the
 * extra directories cannot be checked against the diff, so anchoring there
 * would point at a file the model never named. The finding stays in the summary
 * comment instead, which is the cheaper mistake of the two.
 */
function resolvePath(
  files: Map<string, FilePatchLines>,
  candidate: string,
  allowAbsoluteTail: boolean,
): string | null {
  const keys = [...files.keys()];

  if (files.has(candidate)) return candidate;

  const dropped = keys.filter((key) => key.endsWith(`/${candidate}`));
  if (dropped.length > 1) return null;
  if (dropped.length === 1) return dropped[0] ?? null;

  if (!allowAbsoluteTail) return null;
  const tail = keys.filter((key) => candidate.endsWith(`/${key}`));
  return tail.length === 1 ? (tail[0] ?? null) : null;
}
