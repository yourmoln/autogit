/**
 * Review findings and the two resources they live in.
 *
 * A finding can be attached to a line of the change, but every platform
 * addresses that line differently and all of them refuse (or silently
 * misplace) a comment on a line that is not part of the diff, so the line is
 * resolved against the patch first (`util/diff-anchors.ts`). The inline
 * comments are also a *separate* resource from the conversation comments, and
 * the model only sees the whole discussion when both lists are merged.
 *
 * Both helpers are pure functions of their input, and both are shared: the
 * review flow, the prompt preview and the end-to-end simulation use exactly
 * the same rules.
 */
import type { Comment } from '@autogit/shared';

import { parseDiffAnchors } from '../util/diff-anchors.js';
import type { ReviewIssue } from './runner.js';

/** A finding that can be anchored: where it goes and how a platform gets there. */
export interface ReviewFindingAnchor {
  /** Index of the finding inside `verdict.issues`. */
  index: number;
  /** Repository relative path of the commented file, without `a/` or `b/`. */
  path: string;
  /** Line number in the new version of the file. */
  line: number;
  /**
   * Candidate indexes of that line inside the patch of its file, for the
   * platforms that address a line by its position in the diff.
   */
  diffPositions: readonly number[];
}

/**
 * Resolves every finding that has a usable anchor against the raw patch.
 *
 * Findings without one are left out on purpose: they keep their place in the
 * summary comment, which is always a better outcome than a comment on a line
 * the platform never meant. The returned anchors keep the order of `issues`,
 * so the caller posts them in the order the model reported them.
 */
export function resolveReviewAnchors(
  patch: string,
  issues: readonly ReviewIssue[],
): ReviewFindingAnchor[] {
  if (issues.length === 0 || patch.trim().length === 0) return [];

  const anchors = parseDiffAnchors(patch);
  const resolved: ReviewFindingAnchor[] = [];
  for (const [index, issue] of issues.entries()) {
    const anchor = anchors.find(issue.file, issue.line);
    if (!anchor) continue;
    resolved.push({
      index,
      path: anchor.path,
      line: anchor.line,
      diffPositions: anchor.diffPositions,
    });
  }
  return resolved;
}

/** Inline comment body prefixed with its anchor, for the model's context. */
function inlineCommentBody(comment: Comment): string {
  if (!comment.path) return comment.body;
  const anchor = comment.line ? `\`${comment.path}:${comment.line}\`` : `\`${comment.path}\``;
  return `${anchor}\n${comment.body}`;
}

/**
 * Merges conversation comments with inline review comments.
 *
 * Inline comments are a separate resource on every platform (GitHub even serves
 * them from another endpoint), so a model that only receives `listComments()`
 * never sees them. Gitee returns both kinds from one endpoint, so equal
 * `id` + body pairs are dropped, and every inline body is prefixed with its
 * anchor because the line it belongs to is not part of the text.
 *
 * Exported so the prompt preview (`/api/codex/prompt-preview`) builds exactly
 * the same discussion as the real review run.
 */
export function mergeReviewDiscussion(comments: Comment[], inline: Comment[]): Comment[] {
  const merged = [...comments];
  const seen = new Set(comments.map((comment) => `${comment.id}:${comment.body}`));
  for (const comment of inline) {
    const key = `${comment.id}:${comment.body}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...comment, body: inlineCommentBody(comment) });
  }
  return merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
