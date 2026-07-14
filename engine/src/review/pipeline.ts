/**
 * Review pipeline: build a budgeted digest of a PR's hunks, assemble the
 * reviewer-skeptic prompt, define the structured-output schema, and normalize
 * the model's response by resolving request-local hunk-ID aliases to real diff
 * anchors (anchoring approach adapted from codiff, MIT — see
 * THIRD-PARTY-NOTICES; prompt/schema content is original).
 *
 * Pure Node — no `vscode`.
 *
 * @module
 */

import type {
  AnchoredHunkReview,
  DiffSide,
  FileChange,
  Hunk,
  HunkReview,
  JsonSchema,
  NormalizedReview,
  PullRequestMeta,
  ReviewResult,
} from '../types.js';

/**
 * A single hunk rendered for the prompt, carrying its request-local alias and
 * the (possibly truncated) excerpt.
 */
export interface DigestHunk {
  /** Request-local alias exposed to the model (e.g. `h1`). */
  readonly alias: string;
  /** The stable hunk id this alias maps back to. */
  readonly hunkId: string;
  /** File path the hunk belongs to. */
  readonly path: string;
  /** The hunk excerpt included in the prompt (may be truncated). */
  readonly excerpt: string;
  /** Whether `excerpt` was truncated to fit the budget. */
  readonly truncated: boolean;
}

/** Character budgets governing digest construction. */
export interface DigestBudget {
  /** Max characters per individual hunk excerpt. */
  readonly perHunk: number;
  /** Max total characters across all hunk excerpts. */
  readonly total: number;
}

/** A budgeted digest of all hunks, plus a map from alias back to stable id. */
export interface Digest {
  /** Digest hunks in file/diff order, with aliases assigned. */
  readonly hunks: DigestHunk[];
  /** alias → stable hunk id, for the normalizer to resolve responses. */
  readonly aliasToHunkId: Record<string, string>;
  /** Whether any excerpt was truncated (coverage must be reported). */
  readonly truncated: boolean;
  /** Aliases of hunks whose excerpt was truncated — reported, never silent. */
  readonly truncatedHunks: string[];
  /** Total characters emitted across all excerpts (post-truncation). */
  readonly totalChars: number;
}

/** Default per-hunk / total budgets for a normally-sized PR. */
export const DEFAULT_DIGEST_BUDGET: DigestBudget = {
  perHunk: 2_500,
  total: 60_000,
};

/** Tighter budgets applied when a PR touches more than {@link LARGE_DIGEST_FILE_THRESHOLD} files. */
export const LARGE_DIGEST_BUDGET: DigestBudget = {
  perHunk: 700,
  total: 35_000,
};

/** File count above which {@link LARGE_DIGEST_BUDGET} is used by default. */
export const LARGE_DIGEST_FILE_THRESHOLD = 32;

/** Choose default budgets from the file count. */
function defaultBudgetFor(files: FileChange[]): DigestBudget {
  return files.length > LARGE_DIGEST_FILE_THRESHOLD
    ? LARGE_DIGEST_BUDGET
    : DEFAULT_DIGEST_BUDGET;
}

/**
 * Clamp `text` to at most `maxLen` characters. When truncation happens the last
 * kept character is replaced by an ellipsis so the total length equals `maxLen`.
 * Returns the (possibly clamped) string and whether it was clamped.
 */
function clampExcerpt(text: string, maxLen: number): { excerpt: string; truncated: boolean } {
  if (maxLen <= 0) {
    return { excerpt: '', truncated: text.length > 0 };
  }
  if (text.length <= maxLen) {
    return { excerpt: text, truncated: false };
  }
  if (maxLen === 1) {
    return { excerpt: text.slice(0, 1), truncated: true };
  }
  return { excerpt: `${text.slice(0, maxLen - 1)}…`, truncated: true };
}

/**
 * Build a budgeted digest from parsed files. Assigns request-local aliases
 * (`h1`, `h2`, …) to every hunk — globally sequential across files — and
 * truncates excerpts to satisfy the per-hunk and remaining-total budgets.
 * Truncation is recorded on each {@link DigestHunk} and summarized on the
 * {@link Digest} (`truncated`, `truncatedHunks`, `totalChars`) — never silent.
 *
 * @param files  Parsed file changes.
 * @param budget Per-hunk and total character budgets. When omitted, defaults
 *   are chosen from the file count (see {@link DEFAULT_DIGEST_BUDGET} /
 *   {@link LARGE_DIGEST_BUDGET}).
 * @returns The digest with alias mapping and truncation report.
 */
export function buildDigest(files: FileChange[], budget?: DigestBudget): Digest {
  const effective = budget ?? defaultBudgetFor(files);
  const hunks: DigestHunk[] = [];
  const aliasToHunkId: Record<string, string> = {};
  const truncatedHunks: string[] = [];
  let remainingTotal = effective.total;
  let totalChars = 0;
  let n = 0;

  for (const file of files) {
    for (const hunk of file.hunks) {
      n += 1;
      const alias = `h${n}`;
      const maxLen = Math.max(0, Math.min(effective.perHunk, remainingTotal));
      const { excerpt, truncated } = clampExcerpt(hunk.patch, maxLen);

      remainingTotal = Math.max(0, remainingTotal - excerpt.length);
      totalChars += excerpt.length;
      aliasToHunkId[alias] = hunk.id;
      if (truncated) {
        truncatedHunks.push(alias);
      }

      hunks.push({
        alias,
        hunkId: hunk.id,
        path: file.path,
        excerpt,
        truncated,
      });
    }
  }

  return {
    hunks,
    aliasToHunkId,
    truncated: truncatedHunks.length > 0,
    truncatedHunks,
    totalChars,
  };
}

/**
 * Assemble the reviewer-skeptic review prompt from PR intent sources (title,
 * body) and the budgeted digest. The prompt content is original to ARGUS.
 *
 * @param meta   PR metadata (title/body drive intent).
 * @param digest The budgeted hunk digest.
 * @returns The full prompt text to send to the agent.
 */
export function buildReviewPrompt(meta: PullRequestMeta, digest: Digest): string {
  const intentBody = meta.body.trim() ? meta.body.trim() : '(no description provided)';

  const truncationNote = digest.truncated
    ? `Note: ${digest.truncatedHunks.length} hunk excerpt(s) were truncated to fit the ` +
      `size budget (marked "[truncated]"). Reason carefully about what the omitted ` +
      `lines likely contain and say so in "lookout" when it affects your confidence.`
    : 'All hunk excerpts are included in full.';

  const hunkBlocks = digest.hunks
    .map((h) => {
      const flag = h.truncated ? ' [truncated]' : '';
      return `### ${h.alias} — ${h.path}${flag}\n\`\`\`diff\n${h.excerpt}\n\`\`\``;
    })
    .join('\n\n');

  return `You are ARGUS, a rigorous and skeptical pull-request reviewer. Your job is
not to praise the change but to understand it precisely and to surface what a
careful reviewer must verify before trusting it. Assume nothing works until the
diff shows it does. Do not invent problems, but do not gloss over real risk.

## PR intent (author-stated — treat as a claim to test, not proof)

The title and body below are the author's stated intent. Use them to infer what
the change is *trying* to accomplish, then judge whether the diff actually
delivers that intent.

Title: ${meta.title}

Body:
${intentBody}

## The change

Below is a digest of every changed hunk. Each hunk has a stable alias (h1, h2,
…). ${truncationNote}

${hunkBlocks}

## What to produce

Return a single JSON object (and nothing else) conforming to the provided
schema. Requirements:

- "summary": one plain-language paragraph describing what this PR does.
- "intent": your own explicit statement of what the change is trying to
  accomplish, grounded in the stated intent and confirmed (or contradicted) by
  the diff. Call out any gap between claim and code.
- "critical": the things a reviewer absolutely must know or verify before
  approving — correctness, security, data-loss, breaking-change, or missing-test
  risks. Empty array only if there is genuinely nothing critical.
- "flow": an ordered list of steps a reviewer should read the change in to
  understand it, from entry point to effect. Each step is one short sentence.
- "files": for each meaningfully changed file, its role in the change and a
  short note on what it contributes.
- "hunks": one entry per hunk worth commenting on. For each:
  - "hunkId": the hunk's alias exactly as given above (e.g. "h3"). Reference
    hunks ONLY by these aliases. Never use line numbers or file paths as ids.
  - "why": why this specific change exists / what it does, grounded in the PR
    intent.
  - "lookout": the skeptic note — what could break, what edge case or invariant
    this touches, what a reviewer should double-check.
  - "importance": "critical" (must-review risk), "normal" (worth a look), or
    "context" (mechanical / supporting).

Output JSON only. No markdown, no commentary outside the JSON object.`;
}

/**
 * JSON Schema for the structured review output. Mirrors {@link ReviewResult}
 * (version/summary/intent/critical/flow/files/hunks). Original to ARGUS.
 * `hunks[].hunkId` MUST be a request-local alias (h1, h2, …), never a line
 * number or path — the normalizer resolves it back to a stable hunk id.
 */
export const reviewSchema: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: [
    'version',
    'summary',
    'intent',
    'critical',
    'flow',
    'files',
    'hunks',
  ],
  properties: {
    version: { const: 1 },
    summary: { type: 'string' },
    intent: { type: 'string' },
    critical: { type: 'array', items: { type: 'string' } },
    flow: { type: 'array', items: { type: 'string' } },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'role', 'note'],
        properties: {
          path: { type: 'string' },
          role: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
    hunks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['hunkId', 'why', 'lookout', 'importance'],
        properties: {
          hunkId: {
            type: 'string',
            description:
              'Request-local hunk alias exactly as given in the prompt (e.g. "h3"). Never a line number or path.',
          },
          why: { type: 'string' },
          lookout: { type: 'string' },
          importance: { enum: ['critical', 'normal', 'context'] },
        },
      },
    },
  },
} as const satisfies JsonSchema;

/** Compute the diff-line anchor for a resolved hunk. */
function anchorFor(hunk: Hunk): { side: DiffSide; startLine: number; endLine: number } {
  // A pure-deletion hunk contributes no new-side lines, so it can only be
  // anchored on the old (base) side. Everything else anchors on the new side.
  const isPureDeletion = hunk.newLines === 0;
  const side: DiffSide = isPureDeletion ? 'old' : 'new';
  const startLine = isPureDeletion ? hunk.oldStart : hunk.newStart;
  const lineCount = Math.max(1, isPureDeletion ? hunk.oldLines : hunk.newLines);
  return { side, startLine, endLine: startLine + lineCount - 1 };
}

/**
 * Normalize a raw structured review against the real parsed diff.
 *
 * Resolves each `hunkId` alias to a real {@link Hunk}, computes line anchors,
 * drops unresolvable IDs, dedupes repeated IDs, and reports every real hunk not
 * referenced by any review note as uncovered.
 *
 * @param raw   The structured review returned by the agent.
 * @param files The parsed file changes the review was computed against.
 * @param aliasToHunkId Optional alias→stable-id map from {@link buildDigest};
 *   when omitted, `hunkId`s are treated as already-stable ids.
 * @returns The review plus anchored notes and uncovered hunk ids.
 */
export function normalizeReview(
  raw: ReviewResult,
  files: FileChange[],
  aliasToHunkId?: Record<string, string>,
): NormalizedReview {
  // Index every real hunk by its stable id, preserving file/diff order.
  const hunkById = new Map<string, { hunk: Hunk; path: string }>();
  const orderedIds: string[] = [];
  for (const file of files) {
    for (const hunk of file.hunks) {
      hunkById.set(hunk.id, { hunk, path: file.path });
      orderedIds.push(hunk.id);
    }
  }

  const anchored: AnchoredHunkReview[] = [];
  const covered = new Set<string>();

  for (const note of raw.hunks ?? []) {
    const rawId = note.hunkId;
    if (typeof rawId !== 'string' || rawId.length === 0) {
      continue;
    }
    // Resolve alias → stable id when a map is provided; otherwise the id may
    // already be stable. Fall back to treating the raw id as stable so callers
    // that skip the alias layer still work.
    const stableId = aliasToHunkId?.[rawId] ?? rawId;
    const entry = hunkById.get(stableId);
    if (!entry) {
      // Unknown / unresolvable id — drop it.
      continue;
    }
    if (covered.has(stableId)) {
      // Duplicate reference — keep the first, drop the rest.
      continue;
    }
    covered.add(stableId);

    const { side, startLine, endLine } = anchorFor(entry.hunk);
    const base: HunkReview = {
      hunkId: stableId,
      why: note.why,
      lookout: note.lookout,
      importance: note.importance,
    };
    anchored.push({ ...base, path: entry.path, startLine, endLine, side });
  }

  const uncoveredHunkIds = orderedIds.filter((id) => !covered.has(id));

  return { review: raw, anchored, uncoveredHunkIds };
}
