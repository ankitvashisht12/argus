/**
 * Shared domain types for the ARGUS engine.
 *
 * These types are the contract between the diff parser, the review pipeline,
 * the claude/gh adapters, and the VS Code extension that consumes the engine.
 * Nothing in this file may import `vscode`.
 *
 * @module
 */

/* -------------------------------------------------------------------------- */
/* GitHub / PR domain                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Identity and revision metadata for a single pull request, as resolved from
 * `gh`. `baseSha`/`headSha` pin the exact revisions the review was computed
 * against and feed the stable hunk IDs.
 */
export interface PullRequestMeta {
  /** Repository owner (user or org login). */
  readonly owner: string;
  /** Repository name. */
  readonly repo: string;
  /** PR number within the repository. */
  readonly number: number;
  /** PR title (an intent source for the review prompt). */
  readonly title: string;
  /** PR description body (Markdown; an intent source for the review prompt). */
  readonly body: string;
  /** Commit SHA of the merge base / target revision. */
  readonly baseSha: string;
  /** Commit SHA of the PR head revision. */
  readonly headSha: string;
  /** Base branch ref name (e.g. `main`). */
  readonly baseRef: string;
  /** Head branch ref name (e.g. `feature/x`). */
  readonly headRef: string;
  /** Login of the PR author. */
  readonly author: string;
}

/** Change classification for a file in a diff. */
export type FileStatus =
  | 'added'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'binary';

/**
 * A single changed file with its parsed hunks.
 *
 * For renames, `oldPath` holds the pre-rename path and `path` the new path.
 * Binary files carry no textual hunks (`hunks` is empty, `status` is `binary`).
 */
export interface FileChange {
  /** Current (head-side) path of the file. */
  readonly path: string;
  /** Previous path, present when the file was renamed (or copied). */
  readonly oldPath?: string;
  /** Change classification. */
  readonly status: FileStatus;
  /** Number of added lines across all hunks. */
  readonly additions: number;
  /** Number of deleted lines across all hunks. */
  readonly deletions: number;
  /** Parsed hunks in file order (empty for binary/pure-metadata changes). */
  readonly hunks: Hunk[];
}

/**
 * A contiguous change region within a file.
 *
 * `id` is globally stable and request-independent, formatted as
 * `"<path>:<headSha>:h<n>"` where `n` is the 1-based ordinal of this hunk
 * within its file. The `patch` retains the raw unified-diff hunk text
 * (including the `@@` header) so it can be re-rendered or digested.
 */
export interface Hunk {
  /** Stable hunk identifier: `"<path>:<headSha>:h<n>"`. */
  readonly id: string;
  /** 1-based first line number on the old (base) side. */
  readonly oldStart: number;
  /** Line count on the old (base) side. */
  readonly oldLines: number;
  /** 1-based first line number on the new (head) side. */
  readonly newStart: number;
  /** Line count on the new (head) side. */
  readonly newLines: number;
  /** Raw unified-diff text for this hunk, including its `@@` header. */
  readonly patch: string;
}

/* -------------------------------------------------------------------------- */
/* Review result (structured claude output)                                    */
/* -------------------------------------------------------------------------- */

/** Relative significance of a per-hunk note. */
export type HunkImportance = 'critical' | 'normal' | 'context';

/** Overview + per-file + per-hunk structured review, as returned by claude. */
export interface ReviewResult {
  /** Schema version; always `1` for v1. */
  readonly version: 1;
  /** One-paragraph plain-language summary of the PR. */
  readonly summary: string;
  /** What the change is trying to accomplish (skeptic-inferred intent). */
  readonly intent: string;
  /** Critical things a reviewer must know before approving. */
  readonly critical: string[];
  /** Ordered narrative for understanding the change flow. */
  readonly flow: string[];
  /** Per-file roles/notes. */
  readonly files: FileReview[];
  /** Per-hunk notes keyed by request-local hunk-ID alias. */
  readonly hunks: HunkReview[];
}

/** Per-file commentary. */
export interface FileReview {
  /** File path this review entry describes. */
  readonly path: string;
  /** The file's role in the change (e.g. `entry point`, `test`, `config`). */
  readonly role: string;
  /** Short note about the file's contribution to the PR. */
  readonly note: string;
  /**
   * Short reading-guidance group label for this file (e.g. `Core logic`,
   * `API surface`, `Tests`, `Config & CI`). Files that share a concern share a
   * label. Optional on the type (so cached / fixture reviews and defensive
   * normalization tolerate its absence) even though the review schema requires
   * it; a missing/blank value falls back to a heuristic bucket.
   */
  readonly bucket?: string;
  /**
   * Integer rank (0 = read first) giving the order a reviewer should read files
   * in, arranged so each file is comprehensible from the ones before it
   * (dependencies/core first; generated files, lockfiles and CI/config last).
   * Optional for the same reason as {@link bucket}.
   */
  readonly readingOrder?: number;
}

/**
 * Per-hunk commentary. `hunkId` is the alias the model was given for a hunk in
 * the request digest; the normalizer resolves it to a real {@link Hunk}.
 */
export interface HunkReview {
  /** Request-local hunk-ID alias the model referenced (e.g. `h3`). */
  readonly hunkId: string;
  /** Why this change exists / what it does ("why this change"). */
  readonly why: string;
  /** The skeptic note: risks, edge cases, what to scrutinize ("look out for"). */
  readonly lookout: string;
  /** Relative importance of this hunk to the review. */
  readonly importance: HunkImportance;
}

/* -------------------------------------------------------------------------- */
/* Normalized review (anchored to real diff lines)                             */
/* -------------------------------------------------------------------------- */

/** Which side of the diff an anchor refers to. */
export type DiffSide = 'new' | 'old';

/**
 * A {@link HunkReview} that has been resolved against a real {@link Hunk} and
 * carries concrete line anchors for placement in the diff editor.
 */
export interface AnchoredHunkReview extends HunkReview {
  /** Resolved file path of the anchored hunk. */
  readonly path: string;
  /** 1-based first line of the anchor on `side`. */
  readonly startLine: number;
  /** 1-based last line of the anchor on `side`. */
  readonly endLine: number;
  /** Diff side the anchor lines refer to. */
  readonly side: DiffSide;
}

/**
 * Output of the normalizer: the raw review, its resolved/anchored hunk notes,
 * and the IDs of real hunks that the review never referenced (coverage gap).
 */
export interface NormalizedReview {
  /** The raw structured review as returned by claude. */
  readonly review: ReviewResult;
  /** Hunk notes successfully anchored to real diff lines. */
  readonly anchored: AnchoredHunkReview[];
  /** Stable IDs of real hunks not covered by any review note. */
  readonly uncoveredHunkIds: string[];
}

/* -------------------------------------------------------------------------- */
/* claude adapter                                                              */
/* -------------------------------------------------------------------------- */

/** A JSON Schema object handed to the claude CLI via `--json-schema`. */
export type JsonSchema = Record<string, unknown>;

/** Options controlling a single claude CLI invocation. */
export interface AgentRunOptions {
  /** Primary model id (e.g. `claude-sonnet-4-6`). */
  readonly model?: string;
  /** Model to retry with on an availability error. */
  readonly fallbackModel?: string;
  /** Hard wall-clock timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Working directory the CLI runs in (also passed via `--add-dir`). */
  readonly cwd?: string;
  /** Abort signal to cancel the run. */
  readonly signal?: AbortSignal;
  /** Called when the run falls back from `model` to `fallbackModel`. */
  readonly onModelFallback?: (fallbackModel: string, originalModel: string) => void;
}

/** Result of a structured claude run. */
export interface AgentResult<T = unknown> {
  /** The parsed `structured_output` payload. */
  readonly data: T;
  /** Model id that actually produced the result. */
  readonly model: string;
  /** Raw JSON text of the structured output (before parsing). */
  readonly raw: string;
}

/** An incremental streaming update surfaced from a `stream-json` run. */
export interface ChatDelta {
  /** Kind of delta this event carries. */
  readonly type: 'text' | 'thinking' | 'done' | 'error';
  /** Text fragment for `text`/`thinking`; error message for `error`. */
  readonly text: string;
}

/* -------------------------------------------------------------------------- */
/* gh adapter                                                                  */
/* -------------------------------------------------------------------------- */

/** A single inline comment to attach to a submitted PR review. */
export interface ReviewComment {
  /** File path the comment targets. */
  readonly path: string;
  /** 1-based line number on the diff to anchor the comment. */
  readonly line: number;
  /** Side of the diff the line refers to. */
  readonly side?: 'LEFT' | 'RIGHT';
  /** For multi-line comments, the 1-based first line of the range. */
  readonly startLine?: number;
  /** Side for `startLine` in a multi-line comment. */
  readonly startSide?: 'LEFT' | 'RIGHT';
  /** Comment body (Markdown). */
  readonly body: string;
}

/** The review action to submit to GitHub. */
export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

/** Payload for submitting a PR review with inline comments. */
export interface SubmitReviewInput {
  /** The review action. */
  readonly event: ReviewEvent;
  /** Optional top-level review body. */
  readonly body?: string;
  /** Inline comments to include in the review. */
  readonly comments: ReviewComment[];
}

/** A file entry from the GitHub PR files API. */
export interface PrFile {
  /** Head-side path. */
  readonly path: string;
  /** Pre-rename path, when applicable. */
  readonly previousPath?: string;
  /** Change status as reported by GitHub. */
  readonly status: FileStatus;
  /** Added line count. */
  readonly additions: number;
  /** Deleted line count. */
  readonly deletions: number;
}

/**
 * Wraps the `gh` CLI to read PR data and submit reviews. Implementations shell
 * out to `gh api`; nothing here touches `vscode`.
 */
export interface GhClient {
  /** Resolve PR identity + revision metadata. */
  prMeta(owner: string, repo: string, number: number): Promise<PullRequestMeta>;
  /** Fetch the raw unified diff for a PR. */
  prDiff(owner: string, repo: string, number: number): Promise<string>;
  /** List the changed files for a PR. */
  prFiles(owner: string, repo: string, number: number): Promise<PrFile[]>;
  /**
   * Fetch file content, either by blob SHA or by `path@ref`.
   * @param ref A blob SHA, or a `"<path>@<ref>"` locator.
   */
  fetchBlob(owner: string, repo: string, ref: string): Promise<string>;
  /** Submit a PR review with inline comments and an event. */
  submitReview(
    owner: string,
    repo: string,
    number: number,
    input: SubmitReviewInput,
  ): Promise<void>;
}
