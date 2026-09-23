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
  /** 1-based index of that line in the patch body of its file. */
  position: number;
}

export interface DiffAnchors {
  /** Path -> (new file line -> patch position). */
  readonly files: Map<string, Map<number, number>>;
  /** Resolves a `file` / `line` pair produced by the model into an anchor. */
  find(file: string | null | undefined, line: number | null | undefined): DiffAnchor | null;
}

/** `@@ -oldStart,oldCount +newStart,newCount @@ [context]` (counts may be omitted). */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiffAnchors(diff: string): DiffAnchors {
  const files = new Map<string, Map<number, number>>();
  let path: string | null = null;
  let lines: Map<number, number> | null = null;
  // Position inside the patch of the current file; it keeps counting across
  // hunks, which is how GitHub (and Gitee, which mirrors it) numbers lines.
  let position = 0;
  let newLine = 0;
  let remainingOld = 0;
  let remainingNew = 0;
  let inHunk = false;

  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      path = null;
      lines = null;
      inHunk = false;
      position = 0;
      continue;
    }

    if (inHunk) {
      const marker = raw.charAt(0);
      if (marker === '\\') continue; // "\ No newline at end of file"
      position += 1;
      if (marker === '+') {
        lines?.set(newLine, position);
        newLine += 1;
        remainingNew -= 1;
      } else if (marker === '-') {
        remainingOld -= 1;
      } else {
        // A context line exists in both versions of the file.
        lines?.set(newLine, position);
        newLine += 1;
        remainingOld -= 1;
        remainingNew -= 1;
      }
      if (remainingOld <= 0 && remainingNew <= 0) inHunk = false;
      continue;
    }

    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      newLine = Number(hunk[3]);
      remainingOld = hunk[2] === undefined ? 1 : Number(hunk[2]);
      remainingNew = hunk[4] === undefined ? 1 : Number(hunk[4]);
      inHunk = true;
      if (path) {
        lines = files.get(path) ?? new Map<number, number>();
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

      for (const candidate of pathCandidates(file)) {
        const exact = files.get(candidate)?.get(line);
        if (exact !== undefined) return { path: candidate, line, position: exact };

        // The model may add or drop leading directories (`src/x.ts` vs
        // `apps/web/src/x.ts`), so a unique suffix match is accepted as well.
        const suffix = uniqueSuffix(files, candidate);
        const suffixed = suffix === null ? undefined : files.get(suffix)?.get(line);
        if (suffix !== null && suffixed !== undefined) {
          return { path: suffix, line, position: suffixed };
        }
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

/** The single diff path that `candidate` refers to, or `null` when ambiguous. */
function uniqueSuffix(files: Map<string, Map<number, number>>, candidate: string): string | null {
  const matches = [...files.entries()].filter(
    ([key]) => key.endsWith(`/${candidate}`) || candidate.endsWith(`/${key}`),
  );
  return matches.length === 1 ? (matches[0]?.[0] ?? null) : null;
}
