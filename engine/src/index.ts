/**
 * Public entry point for `@argus/engine`. Re-exports the domain types and the
 * module surfaces the VS Code extension consumes.
 *
 * @module
 */

export * from './types.js';

// diff
export { parseUnifiedDiff } from './diff/parse.js';

// agent
export {
  ClaudeAgent,
  DEFAULT_MODEL,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_TIMEOUT_MS,
  REVIEW_TIMEOUT_BASE_MS,
  REVIEW_TIMEOUT_PER_HUNK_MS,
  REVIEW_TIMEOUT_PER_KB_MS,
  REVIEW_TIMEOUT_CAP_MS,
  computeReviewTimeoutMs,
  resolveReviewTimeoutMs,
  isModelAvailabilityError,
  buildStructuredArgs,
  buildStreamArgs,
} from './agent/claude.js';
export type {
  ClaudeAgentOptions,
  ReviewTimeoutInput,
  SpawnLike,
  SpawnLikeOptions,
  ChildProcessLike,
  ReadableLike,
  WritableLike,
} from './agent/claude.js';

// github
export {
  GhClient,
  GhError,
  BlobNotFoundError,
  PendingReviewError,
  defaultGhExec,
} from './github/gh.js';
export type {
  GhExec,
  GhExecResult,
  GhExecOptions,
} from './github/gh.js';

// review
export {
  buildDigest,
  buildReviewPrompt,
  reviewSchema,
  buildReviewSchema,
  firstChangedLine,
  normalizeReview,
  bucketFiles,
  heuristicBucket,
  READING_BUCKETS,
  DEFAULT_DIGEST_BUDGET,
  LARGE_DIGEST_BUDGET,
  LARGE_DIGEST_FILE_THRESHOLD,
} from './review/pipeline.js';
export type {
  Digest,
  DigestHunk,
  DigestBudget,
  FileBucket,
  HeuristicBucket,
} from './review/pipeline.js';

// store
export {
  ReviewCache,
  KeyValueStore,
  stableStringify,
} from './store/cache.js';
export type {
  ReviewCacheOptions,
  KeyValueStoreOptions,
} from './store/cache.js';
