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
  isModelAvailabilityError,
  humanizeAgentError,
  buildStructuredArgs,
  buildStreamArgs,
} from './agent/claude.js';
export type {
  ClaudeAgentOptions,
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

// progressive review orchestrator
export {
  runProgressiveReview,
  orderForReview,
  isMechanicalFile,
  mechanicalNote,
  sanitizeNote,
  buildIntentPrompt,
  buildFileReviewPrompt,
  buildFileReviewSchema,
  intentSchema,
  PROGRESSIVE_CONCURRENCY,
  PER_FILE_TIMEOUT_MS,
  INTENT_TIMEOUT_MS,
  REVIEW_PROMPT_VERSION,
  FILE_DIGEST_BUDGET,
} from './review/progressive.js';
export type {
  FileReviewStatus,
  FileReviewState,
  IntentResult,
  ProgressiveAgent,
  ProgressiveCache,
  ProgressiveInput,
  ProgressiveCallbacks,
  ProgressiveResult,
  FileReviewPayload,
} from './review/progressive.js';

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
