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

/* -------------------------------------------------------------------------- */
/* Reading-order buckets (heuristic fallback + review normalization)          */
/* -------------------------------------------------------------------------- */

/**
 * Canonical reading buckets in reading order — most foundational first. This is
 * the order the heuristic fallback groups files into when no AI review has
 * landed yet: read the code first (source, then the tests that exercise it),
 * then the prose (docs), then the machinery (config/CI), with generated output
 * and lockfiles last because they are derived, not authored.
 */
export const READING_BUCKETS = [
  'Source',
  'Tests',
  'Docs',
  'Config & CI',
  'Generated',
] as const;

/** One of the canonical {@link READING_BUCKETS} labels. */
export type HeuristicBucket = (typeof READING_BUCKETS)[number];

/** A bucket label plus the files in it, ordered for reading. */
export interface FileBucket {
  /** Group label (a model-supplied label, or a canonical heuristic one). */
  readonly label: string;
  /** Files in this bucket, ordered by reading order then path. */
  readonly files: readonly FileChange[];
}

/** Directory path segments that mark a file as generated/derived output. */
const GENERATED_DIRS = new Set([
  'dist',
  'build',
  'out',
  'coverage',
  'node_modules',
  'vendor',
  '.next',
]);

/** Exact basenames of well-known dependency lockfiles (always Generated). */
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'cargo.lock',
  'poetry.lock',
  'gemfile.lock',
  'go.sum',
]);

/** Directory segments that mark a file as a test. */
const TEST_DIRS = new Set(['test', 'tests', '__tests__', '__mocks__', 'spec', 'e2e']);

/**
 * Classify a path into one of the canonical {@link READING_BUCKETS} using only
 * path/extension patterns — a PURE fallback used to bucket & order the file tree
 * BEFORE any AI review exists (progressive loading), and to give a sensible
 * bucket to any file a review forgot to mention.
 *
 * The checks are ordered most-specific first so a file that could match several
 * categories lands in the right one: a lockfile (`package-lock.json`) is
 * `Generated`, not `Config & CI`, even though it is JSON; a workflow under
 * `.github/` is `Config & CI` even though it is YAML; `foo.test.ts` is `Tests`,
 * not `Source`.
 *
 * @param path Head-side file path (POSIX `/` separators).
 * @returns The canonical bucket label.
 */
export function heuristicBucket(path: string): HeuristicBucket {
  const segments = path.split('/');
  const base = (segments[segments.length - 1] ?? '').toLowerCase();
  const lowerSegs = segments.map((s) => s.toLowerCase());
  const dirSegs = lowerSegs.slice(0, -1);

  // 1. Generated / derived output & lockfiles — highest precedence.
  if (
    LOCKFILES.has(base) ||
    base.endsWith('.lock') ||
    base.endsWith('.min.js') ||
    base.endsWith('.min.css') ||
    base.endsWith('.map') ||
    /\.generated\./.test(base) ||
    base.endsWith('.snap') ||
    dirSegs.some((seg) => GENERATED_DIRS.has(seg))
  ) {
    return 'Generated';
  }

  // 2. Config & CI — dotfiles, CI directories, and config-shaped files.
  if (
    dirSegs.includes('.github') ||
    dirSegs.includes('.circleci') ||
    dirSegs.includes('.gitlab') ||
    base.startsWith('.') || // .gitignore, .eslintrc, .prettierrc, .npmrc, …
    base.startsWith('dockerfile') ||
    base === 'makefile' ||
    base === 'package.json' ||
    /^tsconfig(\..+)?\.json$/.test(base) ||
    /\.config\.[cm]?[jt]sx?$/.test(base) || // vitest.config.ts, eslint.config.mjs
    base.endsWith('.yml') ||
    base.endsWith('.yaml') ||
    base.endsWith('.toml') ||
    base.endsWith('.ini') ||
    base.endsWith('.cfg') ||
    base.endsWith('rc')
  ) {
    return 'Config & CI';
  }

  // 3. Docs — markdown/prose and the docs tree.
  if (
    base.endsWith('.md') ||
    base.endsWith('.mdx') ||
    base.endsWith('.rst') ||
    base.endsWith('.txt') ||
    base === 'license' ||
    base === 'notice' ||
    dirSegs.includes('docs')
  ) {
    return 'Docs';
  }

  // 4. Tests — test/spec files and test directories.
  if (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /_(test|spec)\.[a-z]+$/.test(base) || // foo_test.go, foo_test.py
    dirSegs.some((seg) => TEST_DIRS.has(seg))
  ) {
    return 'Tests';
  }

  // 5. Everything else is source.
  return 'Source';
}

/** Canonical reading rank of a bucket label (unknown labels sort last). */
function canonicalBucketRank(label: string): number {
  const idx = (READING_BUCKETS as readonly string[]).indexOf(label);
  return idx === -1 ? READING_BUCKETS.length : idx;
}

/**
 * Group changed files into reading-ordered buckets.
 *
 * With no `review` (or a review that omits reading guidance) this is the PURE
 * heuristic fallback: files are bucketed by {@link heuristicBucket} and the
 * buckets come out in {@link READING_BUCKETS} order (source → tests → docs →
 * config/CI → generated), alphabetical within each bucket. This is what the tree
 * shows before the AI review lands.
 *
 * With a `review`, each file is placed using the model's `bucket`/`readingOrder`
 * guidance, and the result is ordered by that guidance (buckets by their
 * earliest `readingOrder`, files within a bucket by `readingOrder` then path).
 * Normalization is defensive: a file the review never mentioned (or mentioned
 * with a blank bucket / non-finite order) falls back to its heuristic bucket and
 * sorts after the explicitly-ranked files; review entries for paths that are not
 * in `files` (bogus/unknown paths) are ignored rather than creating phantom rows.
 *
 * Pure — no `vscode` — so both the extension tree and tests can call it.
 *
 * @param files  The actual changed files to bucket (the source of truth for rows).
 * @param review The AI review whose per-file guidance drives ordering, if any.
 * @returns Non-empty buckets in reading order, each with its files in reading order.
 */
export function bucketFiles(
  files: readonly FileChange[],
  review?: ReviewResult | null,
): FileBucket[] {
  // Index the review's per-file guidance by path (defensive against blanks).
  const guidance = new Map<string, { bucket?: string; readingOrder?: number }>();
  for (const entry of review?.files ?? []) {
    if (typeof entry.path === 'string' && entry.path.length > 0) {
      guidance.set(entry.path, {
        bucket: typeof entry.bucket === 'string' ? entry.bucket.trim() : undefined,
        readingOrder:
          typeof entry.readingOrder === 'number' && Number.isFinite(entry.readingOrder)
            ? entry.readingOrder
            : undefined,
      });
    }
  }

  interface Placed {
    readonly file: FileChange;
    readonly label: string;
    /** Finite when the review ranked it; undefined = fallback (sorts last). */
    readonly order?: number;
  }

  const placed: Placed[] = files.map((file) => {
    const g = guidance.get(file.path);
    const label = g?.bucket && g.bucket.length > 0 ? g.bucket : heuristicBucket(file.path);
    return { file, label, order: g?.readingOrder };
  });

  // Collect files per bucket, preserving first-seen label spelling.
  const byLabel = new Map<string, Placed[]>();
  for (const p of placed) {
    const list = byLabel.get(p.label);
    if (list) list.push(p);
    else byLabel.set(p.label, [p]);
  }

  const buckets: FileBucket[] = [];
  for (const [label, list] of byLabel) {
    list.sort(comparePlaced);
    buckets.push({ label, files: list.map((p) => p.file) });
  }

  // Order buckets: those with an explicit (finite) reading rank come first, by
  // their earliest rank; the rest fall back to canonical heuristic order.
  buckets.sort((a, b) => {
    const ao = earliestOrder(byLabel.get(a.label)!);
    const bo = earliestOrder(byLabel.get(b.label)!);
    const aHas = ao !== undefined;
    const bHas = bo !== undefined;
    if (aHas && bHas) return ao - bo || a.label.localeCompare(b.label);
    if (aHas !== bHas) return aHas ? -1 : 1;
    // Neither ranked → canonical heuristic order, then alphabetical.
    return (
      canonicalBucketRank(a.label) - canonicalBucketRank(b.label) ||
      a.label.localeCompare(b.label)
    );
  });

  return buckets;

  function comparePlaced(a: Placed, b: Placed): number {
    const ao = a.order ?? Number.POSITIVE_INFINITY;
    const bo = b.order ?? Number.POSITIVE_INFINITY;
    return ao - bo || a.file.path.localeCompare(b.file.path);
  }

  function earliestOrder(list: Placed[]): number | undefined {
    let min: number | undefined;
    for (const p of list) {
      if (p.order !== undefined && (min === undefined || p.order < min)) min = p.order;
    }
    return min;
  }
}

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

  const aliasList = digest.hunks.map((h) => h.alias).join(', ');
  const hunkCount = digest.hunks.length;

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
- "files": for each meaningfully changed file, its role in the change, a short
  note on what it contributes, and reading guidance:
  - "bucket": a short group label for the file (e.g. "Core logic", "API surface",
    "Tests", "Docs", "Config & CI", "Generated"). Files that share a concern
    share the same label.
  - "readingOrder": an integer rank (0 = read first) giving the order a reviewer
    should read the files in. Order the files so that each is comprehensible from
    the ones before it: foundational/core code and the things others depend on
    first, then the code built on top of them, then tests, then docs — with
    generated files, lockfiles, and CI/config configuration LAST.
- "hunks": you MUST return exactly one entry for EVERY hunk alias listed above.
  There are ${hunkCount} hunk(s): ${aliasList}. Every one of these aliases MUST
  appear in "hunks" exactly once — do not skip any, and do not merge several
  hunks into one entry. Trivial, mechanical, or supporting hunks still get their
  own entry: set "importance": "context" and give a brief "why"/"lookout" rather
  than omitting them. A missing alias is a contract violation. For each entry:
  - "hunkId": the hunk's alias exactly as given above (e.g. "h3"). Reference
    hunks ONLY by these aliases. Never use line numbers or file paths as ids.
  - "why": why this specific change exists / what it does, grounded in the PR
    intent.
  - "lookout": the skeptic note — what could break, what edge case or invariant
    this touches, what a reviewer should double-check. For a trivial hunk it is
    fine to say the change is mechanical and low-risk.
  - "importance": "critical" (must-review risk), "normal" (worth a look), or
    "context" (mechanical / supporting).

Output JSON only. No markdown, no commentary outside the JSON object.`;
}

/**
 * Build the JSON Schema for the structured review output. Mirrors
 * {@link ReviewResult} (version/summary/intent/critical/flow/files/hunks).
 * Original to ARGUS. `hunks[].hunkId` MUST be a request-local alias (h1, h2, …),
 * never a line number or path — the normalizer resolves it back to a stable id.
 *
 * When `hunkCount` is a positive integer the `hunks` array is given
 * `minItems: hunkCount`. Under constrained/structured decoding this steers the
 * model to emit at least one entry per hunk alias, which — together with the
 * prompt's full-coverage contract — is what stops most hunks from silently going
 * uncommented. Callers with the digest in hand (which knows N) should prefer
 * this over the static {@link reviewSchema}.
 *
 * @param hunkCount Number of hunk aliases the model was shown (digest length).
 *   Omit / pass 0 for no lower bound.
 */
export function buildReviewSchema(hunkCount = 0): JsonSchema {
  const hunks: JsonSchema = {
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
  };
  if (Number.isInteger(hunkCount) && hunkCount > 0) {
    hunks.minItems = hunkCount;
  }

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    required: ['version', 'summary', 'intent', 'critical', 'flow', 'files', 'hunks'],
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
          required: ['path', 'role', 'note', 'bucket', 'readingOrder'],
          properties: {
            path: { type: 'string' },
            role: { type: 'string' },
            note: { type: 'string' },
            bucket: {
              type: 'string',
              description:
                'Short reading-group label for the file (e.g. "Core logic", "Tests", "Config & CI").',
            },
            readingOrder: {
              type: 'integer',
              description:
                'Reading rank (0 = read first): dependencies/core first, generated files and config last.',
            },
          },
        },
      },
      hunks,
    },
  };
}

/**
 * Static review schema with no per-hunk lower bound. Retained for callers that
 * do not have the hunk count on hand; prefer {@link buildReviewSchema} with the
 * digest length so coverage is enforced at the schema level.
 */
export const reviewSchema: JsonSchema = buildReviewSchema();

/**
 * Line number (1-based, on `side`) of the FIRST added/changed line in a hunk.
 *
 * The `@@` header's `newStart`/`oldStart` point at the hunk's first line, which
 * is usually a leading *context* line — anchoring a note there puts it above the
 * actual change (and, for a multi-line range, VS Code renders the thread at the
 * range's END line). This walks the hunk patch body, tracking the running
 * old/new line numbers, and returns the line of the first `+` (new side) or `-`
 * (old side) line — the first line the reviewer actually needs to look at.
 *
 * Falls back to the hunk's start line when the body has no changed line on the
 * requested side (a pure-context hunk, which the parser should never emit).
 *
 * Pure — exported for unit testing and reuse.
 *
 * @param hunk The resolved hunk (its `patch` includes the `@@` header).
 * @param side Which side's line number to report (`new` for adds/edits, `old`
 *   for pure deletions).
 * @returns 1-based line number of the first changed line on `side`.
 */
export function firstChangedLine(hunk: Hunk, side: DiffSide): number {
  const want = side === 'new' ? '+' : '-';
  const fallback = side === 'new' ? hunk.newStart : hunk.oldStart;
  const lines = hunk.patch.split('\n');
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  for (const line of lines) {
    if (line.length === 0) continue;
    const marker = line[0];
    if (line.startsWith('@@')) continue; // the @@ hunk header itself
    if (marker === '\\') continue; // "\ No newline at end of file"

    if (marker === '+') {
      if (want === '+') return newLine;
      newLine += 1;
    } else if (marker === '-') {
      if (want === '-') return oldLine;
      oldLine += 1;
    } else {
      // context line (' ') — advances both sides, changes nothing.
      oldLine += 1;
      newLine += 1;
    }
  }

  return fallback;
}

/**
 * Compute the diff-line anchor for a resolved hunk. Anchors to the SINGLE line
 * of the first added/changed line (see {@link firstChangedLine}) so the thread
 * renders exactly on the change rather than spanning the hunk (a multi-line
 * range renders its thread at the END line in VS Code).
 */
function anchorFor(hunk: Hunk): { side: DiffSide; startLine: number; endLine: number } {
  // A pure-deletion hunk contributes no new-side lines, so it can only be
  // anchored on the old (base) side. Everything else anchors on the new side.
  const isPureDeletion = hunk.newLines === 0;
  const side: DiffSide = isPureDeletion ? 'old' : 'new';
  const line = firstChangedLine(hunk, side);
  return { side, startLine: line, endLine: line };
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

  // Build a case-insensitive alias index so a model that returns "H1" / " h1 "
  // instead of the exact "h1" still resolves rather than being silently dropped.
  const aliasIndex = new Map<string, string>();
  if (aliasToHunkId) {
    for (const [alias, id] of Object.entries(aliasToHunkId)) {
      aliasIndex.set(alias.trim().toLowerCase(), id);
    }
  }

  const anchored: AnchoredHunkReview[] = [];
  const covered = new Set<string>();

  for (const note of raw.hunks ?? []) {
    const rawId = typeof note.hunkId === 'string' ? note.hunkId.trim() : '';
    if (rawId.length === 0) {
      continue;
    }
    // Resolve alias → stable id when a map is provided (tolerant of surrounding
    // whitespace and case); otherwise the id may already be stable. Fall back to
    // treating the raw id as stable so callers that skip the alias layer work.
    const stableId = aliasToHunkId
      ? (aliasIndex.get(rawId.toLowerCase()) ?? rawId)
      : rawId;
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
