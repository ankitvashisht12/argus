/**
 * PrSession — the loaded-PR state machine and the single shared state object
 * every ARGUS surface (tree, diff content provider, comment threads, overview
 * panel, sidebar chat, GitHub submit) reads from and subscribes to.
 *
 * It orchestrates the pure `@argus/engine` library: fetch PR meta + diff via
 * `gh`, parse the diff into files/hunks, then run the PROGRESSIVE per-file
 * review — one whole-PR intent pass, then one `claude` call per changed file
 * (bounded concurrency, per-file cache, mechanical lockfile/generated notes
 * synthesized locally) — merging results into line anchors as each file lands.
 * It also owns durable per-PR UI state (reviewed-file set, chat transcript)
 * and streams chat scoped to the digest.
 *
 * This is the ONE module in the extension allowed to be stateful and long-lived;
 * everything else is a thin view over it. It is also the boundary where engine
 * errors become UI-actionable state:
 *
 *   - `gh` missing / unauthenticated is FATAL — without it there is no PR to
 *     show — so {@link PrSession.load} throws a typed {@link ToolUnavailableError}.
 *   - `claude` missing or failing is NON-fatal — the diff must still open
 *     (contract 18) — so the session is fully constructed with `review === null`
 *     and {@link PrSession.reviewError} set to an actionable message. A failed or
 *     absent review is NEVER represented as an empty successful review
 *     (contract 19): `review === null && reviewError !== null` is the error
 *     state; `review !== null` is the only success state.
 *
 * This module imports `vscode` (for {@link vscode.EventEmitter}); it is
 * therefore NOT unit-testable outside the extension host.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import {
  BlobNotFoundError,
  ClaudeAgent,
  DEFAULT_MODEL,
  GhClient,
  KeyValueStore,
  PER_FILE_TIMEOUT_MS,
  ReviewCache,
  buildDigest,
  humanizeAgentError,
  parseUnifiedDiff,
  runProgressiveReview,
} from '@argus/engine';
import type {
  AnchoredHunkReview,
  ChatDelta,
  Digest,
  FileChange,
  FileReview,
  FileReviewState,
  NormalizedReview,
  ProgressiveResult,
  PullRequestMeta,
} from '@argus/engine';

import demoFixtureJson from './fixtures/demo.json';

/* -------------------------------------------------------------------------- */
/* Public option / result shapes                                              */
/* -------------------------------------------------------------------------- */

/** Which external CLI a {@link ToolUnavailableError} refers to. */
export type ArgusTool = 'gh' | 'claude';

/** Why a required CLI could not be used. */
export type ToolUnavailableReason = 'missing' | 'unauthenticated';

/**
 * Thrown (for `gh`) or surfaced via {@link PrSession.reviewError} (for `claude`)
 * when a required external CLI is missing or not authenticated. Carries enough
 * structure for the UI to render an actionable call to action (install / login)
 * rather than a raw stack trace.
 */
export class ToolUnavailableError extends Error {
  constructor(
    readonly tool: ArgusTool,
    readonly reason: ToolUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = 'ToolUnavailableError';
  }
}

/** Options for {@link PrSession.load}. */
export interface PrSessionLoadOptions {
  /** Repository owner (user or org login). */
  readonly owner: string;
  /** Repository name. */
  readonly repo: string;
  /** PR number. */
  readonly number: number;
  /**
   * Root directory for durable state (typically the extension's
   * `globalStorageUri.fsPath`). The review cache and per-PR key/value state
   * live under here.
   */
  readonly storageDir: string;
  /** Model id for the review + chat calls (defaults to the engine default). */
  readonly agentModel?: string;
  /**
   * Live accessor for the `argus.reviewTimeoutSeconds` setting (seconds). A
   * positive value overrides the fixed PER-FILE call timeout (each progressive
   * review call covers one file); `0`/`undefined` means the default. Read fresh
   * on every review so changing the setting and regenerating takes effect
   * immediately. Defaults to reading the VS Code configuration; injectable for
   * tests.
   */
  readonly reviewTimeoutSeconds?: () => number | undefined;
  /** Progress messages for a status bar / notification while loading. */
  readonly onProgress?: (message: string) => void;
  /**
   * Injectable `gh` client (tests / alternate transports). Defaults to a real
   * {@link GhClient} over the `gh` binary.
   */
  readonly gh?: GhClient;
  /**
   * Injectable `claude` agent. Defaults to a real {@link ClaudeAgent} over the
   * `claude` binary.
   */
  readonly agent?: ClaudeAgent;
}

/** Options for {@link PrSession.chat}. */
export interface ChatOptions {
  /** Path of the file the user is currently focused on, to scope the answer. */
  readonly focusPath?: string;
  /** Abort signal to cancel the streaming run. */
  readonly signal?: AbortSignal;
}

/**
 * A user draft review comment, persisted across window reloads so the reviewer
 * can stop and resume (contract: the landing page's "stop & resume" promise).
 *
 * Serialized by `comments.ts` from the live draft-thread registry on every
 * add/edit/delete and restored when a session for the SAME PR is adopted. The
 * `side` is the `argus://` document authority (`base`/`head`), matching
 * `DraftComment.side` in `comments.ts`, so the two shapes are interchangeable.
 */
export interface PersistedDraft {
  /** Side-appropriate file path the comment targets (base uses the pre-rename path). */
  readonly path: string;
  /** 1-based anchor line within the diff document. */
  readonly line: number;
  /** Diff side (`base`/`head`) — the `argus://` document authority. */
  readonly side: 'base' | 'head';
  /** The comment body text (Markdown). */
  readonly body: string;
  /** Optional stable id (unused today; reserved so restored ids can round-trip). */
  readonly id?: number;
}

/** A single turn in the per-PR chat transcript. */
export interface ChatMessage {
  /** Who produced the message. */
  readonly role: 'user' | 'assistant';
  /** Message text (Markdown for assistant turns). */
  readonly content: string;
  /** Unix epoch milliseconds when the turn was recorded. */
  readonly ts: number;
}

/** The overview slice of a review, for the overview webview. */
export interface ReviewOverview {
  /** One-paragraph plain-language summary. */
  readonly summary: string;
  /** Explicit, skeptic-inferred intent of the change. */
  readonly intent: string;
  /** Things a reviewer must verify before approving. */
  readonly critical: readonly string[];
  /** Ordered read-order narrative. */
  readonly flow: readonly string[];
}

/** Base or head side of the diff, for {@link PrSession.fileContents}. */
export type BlobSide = 'base' | 'head';

/**
 * Lifecycle of the AI review, independent of {@link PrSession.review} /
 * {@link PrSession.reviewError} (which remain the source of truth for contract
 * 19). Progressive loading means a live session is returned with the diff usable
 * while the review is still `'running'`.
 *
 *   - `'idle'`    — no review has started (transient; a live load flips to
 *                   `'running'` immediately, demo sessions start `'ready'`).
 *   - `'running'` — the AI review is generating in the background.
 *   - `'ready'`   — {@link PrSession.review} is populated.
 *   - `'error'`   — {@link PrSession.reviewError} is set, `review` is `null`.
 */
export type ReviewStatus = 'idle' | 'running' | 'ready' | 'error';

/**
 * Accessor a surface uses to reach the current session lazily. Returns `null`
 * when no PR is loaded. Surfaces register once at activation and read through
 * this so they survive review/regenerate without re-registration.
 */
export type SessionAccessor = () => PrSession | null;

/** The de-serialized shape of `fixtures/demo.json` (and any demo file). */
export interface DemoFixture {
  readonly meta: PullRequestMeta;
  readonly files: FileChange[];
  readonly review: NormalizedReview;
}

/* -------------------------------------------------------------------------- */
/* Internal construction deps                                                 */
/* -------------------------------------------------------------------------- */

interface PrSessionDeps {
  readonly meta: PullRequestMeta;
  readonly files: FileChange[];
  readonly digest: Digest;
  readonly model: string;
  readonly reviewTimeoutSeconds: () => number | undefined;
  readonly review: NormalizedReview | null;
  readonly reviewError: string | null;
  readonly reviewed: Set<string>;
  readonly chatHistory: ChatMessage[];
  readonly drafts: PersistedDraft[];
  /** `null` in demo mode (no live `gh`). */
  readonly gh: GhClient | null;
  /** `null` in demo mode / when `claude` is absent. */
  readonly agent: ClaudeAgent | null;
  /** `null` in demo mode (no persistence). */
  readonly cache: ReviewCache | null;
  /** `null` in demo mode (no persistence). */
  readonly kv: KeyValueStore | null;
}

const REVIEWED_KEY = 'reviewed';
const CHAT_KEY = 'chat';
const DRAFTS_KEY = 'drafts';

/* -------------------------------------------------------------------------- */
/* PrSession                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Loaded, observable state for a single pull request under review.
 *
 * Construct via the static {@link PrSession.load} (live PR) or
 * {@link PrSession.loadDemo} (bundled fixture, no `gh`/`claude`). Surfaces read
 * the getters and subscribe to {@link PrSession.onDidChangeReview} /
 * {@link PrSession.onDidChangeReviewedState}.
 */
export class PrSession {
  readonly #meta: PullRequestMeta;
  readonly #files: FileChange[];
  readonly #digest: Digest;
  readonly #model: string;
  readonly #reviewTimeoutSeconds: () => number | undefined;
  readonly #reviewed: Set<string>;
  readonly #chatHistory: ChatMessage[];
  #drafts: PersistedDraft[];

  readonly #gh: GhClient | null;
  readonly #agent: ClaudeAgent | null;
  readonly #cache: ReviewCache | null;
  readonly #kv: KeyValueStore | null;

  #review: NormalizedReview | null;
  #reviewError: string | null;
  #reviewStatus: ReviewStatus;
  /** In-flight background review, so callers/tests can await it settling. */
  #reviewInFlight: Promise<void> | null = null;
  /** Per-file review lifecycle for the progressive run (empty in demo mode). */
  #fileStates = new Map<string, FileReviewState>();
  /** Last progressive result, kept so a single-file retry can merge into it. */
  #lastResult: ProgressiveResult | null = null;

  readonly #onDidChangeReview = new vscode.EventEmitter<void>();
  readonly #onDidChangeReviewedState = new vscode.EventEmitter<string>();

  /** Fires whenever {@link review} or {@link reviewError} changes. */
  readonly onDidChangeReview: vscode.Event<void> = this.#onDidChangeReview.event;
  /** Fires with the file path whose reviewed state toggled. */
  readonly onDidChangeReviewedState: vscode.Event<string> =
    this.#onDidChangeReviewedState.event;

  private constructor(deps: PrSessionDeps) {
    this.#meta = deps.meta;
    this.#files = deps.files;
    this.#digest = deps.digest;
    this.#model = deps.model;
    this.#reviewTimeoutSeconds = deps.reviewTimeoutSeconds;
    this.#review = deps.review;
    this.#reviewError = deps.reviewError;
    // Derive the initial lifecycle from the constructed review: a demo session
    // arrives with its fixture review already present (`ready`); a live session
    // arrives blank (`idle`) and `load` flips it to `running` right away.
    this.#reviewStatus = deps.review ? 'ready' : deps.reviewError ? 'error' : 'idle';
    this.#reviewed = deps.reviewed;
    this.#chatHistory = deps.chatHistory;
    this.#drafts = deps.drafts;
    this.#gh = deps.gh;
    this.#agent = deps.agent;
    this.#cache = deps.cache;
    this.#kv = deps.kv;
  }

  /* ---------------------------------------------------------------------- */
  /* Construction                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Load a live PR in TWO stages (progressive loading):
   *
   *   1. Foreground (awaited): fetch meta + diff via `gh`, parse the diff, build
   *      the digest, and restore durable UI state. The returned session's tree,
   *      diffs and file details are usable immediately.
   *   2. Background (NOT awaited): the AI review starts automatically via
   *      {@link startReview} (respecting the content-hash cache — a hit still
   *      populates near-instantly). {@link reviewStatus} is `'running'` by the
   *      time this resolves, and {@link onDidChangeReview} fires when it lands.
   *
   * The `onProgress` callback only covers stage 1 (the fetch); the background
   * review reports through {@link reviewStatus} / {@link onDidChangeReview}.
   *
   * `gh` availability is a hard precondition: if the `gh` binary is missing or
   * unauthenticated this rejects with a typed {@link ToolUnavailableError} and
   * no session is produced. A `claude` problem is not fatal — the session ends
   * up with `review === null` and `reviewError` set, so the diff still opens
   * without AI.
   *
   * @throws {ToolUnavailableError} when `gh` is missing or unauthenticated.
   */
  static async load(options: PrSessionLoadOptions): Promise<PrSession> {
    const { owner, repo, number, storageDir } = options;
    const model = options.agentModel ?? DEFAULT_MODEL;
    const progress = options.onProgress ?? (() => undefined);
    const gh = options.gh ?? new GhClient();
    const agent = options.agent ?? new ClaudeAgent();
    const reviewTimeoutSeconds =
      options.reviewTimeoutSeconds ??
      (() =>
        vscode.workspace
          .getConfiguration('argus')
          .get<number>('reviewTimeoutSeconds'));

    await PrSession.#assertGhReady(gh);

    progress('Fetching pull request metadata…');
    const meta = await gh.prMeta(owner, repo, number);

    progress('Fetching diff…');
    const diffText = await gh.prDiff(owner, repo, number);
    const files = parseUnifiedDiff(diffText, meta.headSha);
    const digest = buildDigest(files);

    const cache = new ReviewCache({ dir: join(storageDir, 'review-cache') });
    const kv = new KeyValueStore({
      file: join(storageDir, `state-${owner}-${repo}-${number}.json`),
    });

    const reviewed = new Set(
      (await kv.get<string[]>(REVIEWED_KEY)) ?? [],
    );
    const chatHistory = (await kv.get<ChatMessage[]>(CHAT_KEY)) ?? [];
    const drafts = (await kv.get<PersistedDraft[]>(DRAFTS_KEY)) ?? [];

    const session = new PrSession({
      meta,
      files,
      digest,
      model,
      reviewTimeoutSeconds,
      review: null,
      reviewError: null,
      reviewed,
      chatHistory,
      drafts,
      gh,
      agent,
      cache,
      kv,
    });

    // Stage 2 — kick off the AI review in the background. Deliberately NOT
    // awaited: the caller adopts the session now (files/tree/diffs live) and the
    // review streams in, flipping `reviewStatus` and firing `onDidChangeReview`.
    session.#reviewInFlight = session.startReview({ bypassCache: false });
    return session;
  }

  /**
   * Construct a session from a bundled JSON fixture with NO `gh`/`claude` — for
   * the "Open Demo Review" command and for developing surfaces offline
   * (contract 15). The review is taken verbatim from the fixture; reviewed state
   * and chat are in-memory only (not persisted), and live-only operations
   * (chat, regenerate, fileContents) are unavailable.
   *
   * @param fixturePath Absolute path to a demo JSON file. When omitted, the
   *   fixture bundled with the extension (`fixtures/demo.json`) is used.
   */
  static async loadDemo(fixturePath?: string): Promise<PrSession> {
    const fixture: DemoFixture = fixturePath
      ? (JSON.parse(await readFile(fixturePath, 'utf8')) as DemoFixture)
      : (demoFixtureJson as unknown as DemoFixture);

    return new PrSession({
      meta: fixture.meta,
      files: fixture.files,
      digest: buildDigest(fixture.files),
      model: DEFAULT_MODEL,
      // Demo sessions never run a live review, so the timeout is never consulted.
      reviewTimeoutSeconds: () => undefined,
      review: fixture.review,
      reviewError: null,
      reviewed: new Set<string>(),
      chatHistory: [],
      drafts: [],
      gh: null,
      agent: null,
      cache: null,
      kv: null,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Read surface                                                            */
  /* ---------------------------------------------------------------------- */

  /** PR identity + revision metadata. */
  get meta(): PullRequestMeta {
    return this.#meta;
  }

  /** Parsed changed files with their hunks, in diff order. */
  get files(): readonly FileChange[] {
    return this.#files;
  }

  /**
   * The normalized AI review, or `null` when it has not (successfully) run.
   * `null` together with a non-null {@link reviewError} is the error state;
   * a non-null value is the only success state. Never a fake empty review.
   */
  get review(): NormalizedReview | null {
    return this.#review;
  }

  /** Actionable error message when the review failed / is unavailable, else `null`. */
  get reviewError(): string | null {
    return this.#reviewError;
  }

  /**
   * Lifecycle of the AI review — see {@link ReviewStatus}. Surfaces read this to
   * show a "reviewing…" affordance while `'running'` without conflating it with
   * the error state (contract 19: `'error'` implies `review === null`).
   */
  get reviewStatus(): ReviewStatus {
    return this.#reviewStatus;
  }

  /**
   * Resolve when the in-flight background review (if any) has settled. Resolves
   * immediately when no review is running. Never rejects — a failed review is
   * captured in {@link reviewError} / {@link reviewStatus}, not thrown here.
   */
  reviewSettled(): Promise<void> {
    return this.#reviewInFlight ?? Promise.resolve();
  }

  /** Per-file review state (progressive run), or `undefined` before it starts. */
  fileReviewState(path: string): FileReviewState | undefined {
    return this.#fileStates.get(path);
  }

  /**
   * Live progress of the progressive review, for the status bar and the
   * Overview: completed/total counts plus the paths currently being reviewed.
   * `null` when no progressive run has produced any state (demo fixtures).
   */
  get reviewProgress(): {
    readonly done: number;
    readonly failed: number;
    readonly total: number;
    readonly running: readonly string[];
    readonly files: readonly { path: string; status: string; error: string | null }[];
  } | null {
    if (this.#fileStates.size === 0) return null;
    let done = 0;
    let failed = 0;
    const running: string[] = [];
    const files: { path: string; status: string; error: string | null }[] = [];
    for (const [path, state] of this.#fileStates) {
      if (state.status === 'ready') done += 1;
      if (state.status === 'error') failed += 1;
      if (state.status === 'running') running.push(path);
      files.push({ path, status: state.status, error: state.error ?? null });
    }
    return { done, failed, total: this.#fileStates.size, running, files };
  }

  /** Overview slice for the overview webview, or `null` with no review. */
  get overview(): ReviewOverview | null {
    if (!this.#review) return null;
    const { summary, intent, critical, flow } = this.#review.review;
    return { summary, intent, critical, flow };
  }

  /** Anchored hunk notes for a file, in diff order (empty when no review). */
  anchorsForFile(path: string): AnchoredHunkReview[] {
    return (this.#review?.anchored ?? []).filter((a) => a.path === path);
  }

  /** Per-file review note for a path, or `undefined`. */
  fileReview(path: string): FileReview | undefined {
    return this.#review?.review.files.find((f) => f.path === path);
  }

  /** Whether the user has marked `path` as reviewed. */
  isReviewed(path: string): boolean {
    return this.#reviewed.has(path);
  }

  /** The persisted chat transcript for this PR. */
  get chatHistory(): readonly ChatMessage[] {
    return this.#chatHistory;
  }

  /**
   * The user draft review comments persisted for this PR (restored from durable
   * state at load). `comments.ts` reads this once when adopting a session for the
   * same PR to recreate the draft threads, and keeps it current via
   * {@link saveDrafts} on every add/edit/delete.
   */
  get drafts(): readonly PersistedDraft[] {
    return this.#drafts;
  }

  /* ---------------------------------------------------------------------- */
  /* Mutations                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Toggle a file's reviewed state; persists across window reloads (contract 13)
   * and fires {@link onDidChangeReviewedState}. No-op if already in that state.
   */
  async setReviewed(path: string, reviewed: boolean): Promise<void> {
    if (this.#reviewed.has(path) === reviewed) return;
    if (reviewed) this.#reviewed.add(path);
    else this.#reviewed.delete(path);
    this.#onDidChangeReviewedState.fire(path);
    await this.#kv?.set(REVIEWED_KEY, [...this.#reviewed]);
  }

  /**
   * Persist the current set of user draft review comments across window reloads
   * (contract: stop & resume). Called by `comments.ts` on every draft
   * add/edit/delete and with `[]` after a successful GitHub submit clears them.
   * No-op persistence in demo mode (`#kv === null`), but the in-memory snapshot
   * is still updated so {@link drafts} stays consistent within the session.
   */
  async saveDrafts(drafts: readonly PersistedDraft[]): Promise<void> {
    this.#drafts = [...drafts];
    await this.#kv?.set(DRAFTS_KEY, this.#drafts);
  }

  /**
   * Re-run the AI review, bypassing the content-hash cache (the
   * "ARGUS: Regenerate Review" command). Fires {@link onDidChangeReview}.
   *
   * A demo/fixture session has no live agent (`#agent === null`) and its review
   * comes verbatim from the fixture. There is nothing to regenerate, and routing
   * it through {@link #runReview} would hit the "claude not found" branch and
   * wipe the fixture into an error state. So it is a no-op that simply re-emits
   * the existing fixture review, leaving `review`/`reviewError` untouched.
   */
  async regenerate(): Promise<void> {
    if (!this.#agent) {
      this.#onDidChangeReview.fire();
      return;
    }
    this.#reviewInFlight = this.startReview({ bypassCache: true });
    await this.#reviewInFlight;
  }

  /**
   * Flip {@link reviewStatus} to `'running'` (firing {@link onDidChangeReview}
   * so the UI can show a "reviewing…" state), then run the review pipeline to
   * completion. Shared by the initial background load and {@link regenerate}.
   *
   * Resolves once the review has settled into `'ready'` or `'error'`; it does
   * not reject — failures land in {@link reviewError} (contract 19).
   */
  async startReview(opts: {
    bypassCache: boolean;
    onlyPaths?: readonly string[];
    progress?: (message: string) => void;
  }): Promise<void> {
    this.#reviewStatus = 'running';
    this.#reviewError = null;
    this.#onDidChangeReview.fire();
    await this.#runReview(opts);
  }

  /**
   * Retry the AI review of a SINGLE file (the per-file Retry action in the
   * Overview after that file's call failed or timed out). Re-runs just that
   * file — every other file keeps its existing notes — and merges the result.
   * No-op in demo mode or before a progressive run has produced state.
   */
  async retryFile(path: string): Promise<void> {
    if (!this.#agent || !this.#lastResult) return;
    this.#reviewInFlight = this.startReview({
      bypassCache: true,
      onlyPaths: [path],
    });
    await this.#reviewInFlight;
  }

  /**
   * Stream a chat answer about this PR, scoped to the digest and (optionally)
   * the focused file. Deltas are forwarded to `onDelta`; the resolved value is
   * the full answer text. Both turns are appended to (and persisted with) the
   * transcript. In demo mode / with `claude` absent, emits an error delta and
   * resolves to `''`.
   */
  async chat(
    prompt: string,
    onDelta: (delta: ChatDelta) => void,
    options?: ChatOptions,
  ): Promise<string> {
    if (!this.#agent) {
      onDelta({ type: 'error', text: 'Claude Code is not available in this session.' });
      onDelta({ type: 'done', text: '' });
      return '';
    }

    this.#chatHistory.push({ role: 'user', content: prompt, ts: Date.now() });
    const fullPrompt = this.#buildChatPrompt(prompt, options?.focusPath);

    let answer = '';
    try {
      answer = await this.#agent.chatStream(
        fullPrompt,
        { model: this.#model, signal: options?.signal },
        onDelta,
      );
    } finally {
      this.#chatHistory.push({ role: 'assistant', content: answer, ts: Date.now() });
      await this.#kv?.set(CHAT_KEY, this.#chatHistory);
    }
    return answer;
  }

  /* ---------------------------------------------------------------------- */
  /* Blob access (for the diff content provider)                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Fetch the base- or head-side content of a file via `gh`, for the
   * `argus://` diff content provider. A file absent on that side (added on
   * head, deleted on base) resolves to `''` rather than throwing. Unavailable
   * in demo mode.
   *
   * @throws {Error} in demo mode (no live `gh`).
   */
  async fileContents(path: string, side: BlobSide): Promise<string> {
    if (!this.#gh) {
      throw new Error('File contents are unavailable in demo mode.');
    }
    const sha = side === 'base' ? this.#meta.baseSha : this.#meta.headSha;
    try {
      return await this.#gh.fetchBlob(this.#meta.owner, this.#meta.repo, `${path}@${sha}`);
    } catch (error) {
      if (error instanceof BlobNotFoundError) return '';
      throw error;
    }
  }

  /** Release the event emitters. Call when the session is discarded. */
  dispose(): void {
    this.#onDidChangeReview.dispose();
    this.#onDidChangeReviewedState.dispose();
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  /** Verify `gh` is installed and authenticated, or throw a typed error. */
  static async #assertGhReady(gh: GhClient): Promise<void> {
    if (!(await gh.isAvailable())) {
      throw new ToolUnavailableError(
        'gh',
        'missing',
        'The GitHub CLI (`gh`) was not found. Install it from https://cli.github.com and ensure `gh` is on your PATH.',
      );
    }
    if (!(await gh.isAuthed())) {
      throw new ToolUnavailableError(
        'gh',
        'unauthenticated',
        'The GitHub CLI is not authenticated. Run `gh auth login` in a terminal, then retry.',
      );
    }
  }

  /**
   * Run the progressive per-file review into {@link review} /
   * {@link reviewError}, firing {@link onDidChangeReview} as the intent pass and
   * then each file's notes land (partial reviews are usable immediately).
   *
   * Failure posture: one file failing/timing out marks THAT file's state as
   * `'error'` (retryable from the Overview) and never poisons the rest. The
   * whole review lands in the `'error'` state only when nothing could run at
   * all — claude missing, or every AI-reviewed file failed with no prior
   * result. Contract 19 still holds for that state: `review === null` with an
   * actionable `reviewError`.
   */
  async #runReview(opts: {
    bypassCache: boolean;
    onlyPaths?: readonly string[];
    progress?: (message: string) => void;
  }): Promise<void> {
    const progress = opts.progress ?? (() => undefined);
    this.#reviewError = null;

    if (!this.#agent || !(await this.#agent.isAvailable())) {
      this.#setReviewError(
        'Claude Code (`claude`) was not found, so no AI review was generated. ' +
          'Install Claude Code and confirm `claude --version` runs, then use ' +
          '“ARGUS: Regenerate Review”. The diff is still available without AI.',
      );
      return;
    }

    progress('Generating AI review…');
    // A positive `argus.reviewTimeoutSeconds` overrides the fixed per-file
    // budget (each call reviews ONE file, so the default suffices for most PRs).
    const overrideSeconds = this.#reviewTimeoutSeconds();
    const perFileTimeoutMs =
      typeof overrideSeconds === 'number' &&
      Number.isFinite(overrideSeconds) &&
      overrideSeconds > 0
        ? Math.round(overrideSeconds * 1000)
        : PER_FILE_TIMEOUT_MS;

    try {
      const result = await runProgressiveReview(
        {
          meta: this.#meta,
          files: this.#files,
          agent: this.#agent,
          model: this.#model,
          cache: this.#cache,
          bypassCache: opts.bypassCache,
          perFileTimeoutMs,
          onlyPaths: opts.onlyPaths,
          prior: opts.onlyPaths ? this.#lastResult : null,
          onModelFallback: (fallback, original) =>
            progress(`Model ${original} unavailable; retried with ${fallback}.`),
        },
        {
          onSnapshot: (snapshot) => {
            // Live partial review: keep status 'running' but let every surface
            // render what has landed so far.
            this.#review = snapshot;
            this.#onDidChangeReview.fire();
          },
          onFileState: (path, state) => {
            this.#fileStates.set(path, state);
            this.#onDidChangeReview.fire();
          },
        },
      );

      this.#lastResult = result;
      this.#fileStates = new Map(Object.entries(result.fileStates));

      // Total failure = not a single file produced notes (mechanical files
      // count — an all-lockfile PR is legitimately ready). Anything partial
      // stays 'ready' with per-file error states retryable from the Overview.
      const states = [...this.#fileStates.values()];
      const readyCount = states.filter((s) => s.status === 'ready').length;
      const errorCount = states.filter((s) => s.status === 'error').length;
      if (readyCount === 0 && errorCount > 0) {
        const first = states.find((s) => s.error)?.error ?? 'The AI review failed.';
        this.#setReviewError(this.#reviewErrorMessage(first));
        return;
      }
      this.#setReview(result.review);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#setReviewError(this.#reviewErrorMessage(message));
    }
  }

  /**
   * Turn a raw review failure into an actionable message: login/usage-limit
   * failures get their specific call to action (via the engine's
   * `humanizeAgentError`), and a timeout points at Regenerate + the
   * `argus.reviewTimeoutSeconds` setting. The engine's evidence (elapsed time +
   * last CLI output) is already inside the raw message and is preserved.
   */
  #reviewErrorMessage(rawMessage: string): string {
    const humanized = humanizeAgentError(rawMessage);
    if (humanized !== rawMessage) return humanized;
    if (!/timed out/i.test(rawMessage)) return rawMessage;
    return (
      `${rawMessage} Run “ARGUS: Regenerate Review” to try again, or raise the ` +
      '“argus.reviewTimeoutSeconds” setting to allow more time per file. The ' +
      'diff is still available without AI.'
    );
  }

  #setReview(review: NormalizedReview): void {
    this.#review = review;
    this.#reviewError = null;
    this.#reviewStatus = 'ready';
    this.#onDidChangeReview.fire();
  }

  #setReviewError(message: string): void {
    this.#review = null;
    this.#reviewError = message;
    this.#reviewStatus = 'error';
    this.#onDidChangeReview.fire();
  }

  /** Compose a chat prompt scoped to the PR digest and optional focus file. */
  #buildChatPrompt(userPrompt: string, focusPath?: string): string {
    const hunkBlocks = this.#digest.hunks
      .map((h) => `### ${h.alias} — ${h.path}\n\`\`\`diff\n${h.excerpt}\n\`\`\``)
      .join('\n\n');

    const focusNote = focusPath
      ? `The user is currently looking at \`${focusPath}\`. Prefer answering in ` +
        `terms of that file when the question is ambiguous.`
      : 'The user has no specific file focused.';

    const priorTurns = this.#chatHistory
      .slice(-6)
      .map((m) => `${m.role === 'user' ? 'User' : 'ARGUS'}: ${m.content}`)
      .join('\n');

    return `You are ARGUS, a skeptical reviewer answering questions about a specific
pull request. Ground every answer in the diff below; if the diff does not show
something, say so rather than guessing.

## PR
Title: ${this.#meta.title}
Repo: ${this.#meta.owner}/${this.#meta.repo}#${this.#meta.number}

## Focus
${focusNote}

## Changed hunks
${hunkBlocks}

${priorTurns ? `## Conversation so far\n${priorTurns}\n` : ''}
## Question
${userPrompt}`;
  }
}
