/**
 * PrSession — the loaded-PR state machine and the single shared state object
 * every ARGUS surface (tree, diff content provider, comment threads, overview
 * panel, sidebar chat, GitHub submit) reads from and subscribes to.
 *
 * It orchestrates the pure `@argus/engine` library: fetch PR meta + diff via
 * `gh`, parse the diff into files/hunks, build a budgeted digest, run one
 * structured `claude` review (skipping it on a content-hash cache hit), and
 * normalize the result into line anchors. It also owns durable per-PR UI state
 * (reviewed-file set, chat transcript) and streams chat scoped to the digest.
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
  ReviewCache,
  buildDigest,
  buildReviewPrompt,
  normalizeReview,
  parseUnifiedDiff,
  reviewSchema,
  stableStringify,
} from '@argus/engine';
import type {
  AnchoredHunkReview,
  ChatDelta,
  Digest,
  FileChange,
  FileReview,
  NormalizedReview,
  PullRequestMeta,
  ReviewResult,
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
  readonly review: NormalizedReview | null;
  readonly reviewError: string | null;
  readonly reviewed: Set<string>;
  readonly chatHistory: ChatMessage[];
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
  readonly #reviewed: Set<string>;
  readonly #chatHistory: ChatMessage[];

  readonly #gh: GhClient | null;
  readonly #agent: ClaudeAgent | null;
  readonly #cache: ReviewCache | null;
  readonly #kv: KeyValueStore | null;

  #review: NormalizedReview | null;
  #reviewError: string | null;

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
    this.#review = deps.review;
    this.#reviewError = deps.reviewError;
    this.#reviewed = deps.reviewed;
    this.#chatHistory = deps.chatHistory;
    this.#gh = deps.gh;
    this.#agent = deps.agent;
    this.#cache = deps.cache;
    this.#kv = deps.kv;
  }

  /* ---------------------------------------------------------------------- */
  /* Construction                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Load a live PR: fetch meta + diff via `gh`, parse the diff, build the
   * digest, restore durable UI state, and run (or cache-hit) the AI review.
   *
   * `gh` availability is a hard precondition: if the `gh` binary is missing or
   * unauthenticated this rejects with a typed {@link ToolUnavailableError} and
   * no session is produced. A `claude` problem is not fatal — the returned
   * session has `review === null` and `reviewError` set, so the diff still
   * opens without AI.
   *
   * @throws {ToolUnavailableError} when `gh` is missing or unauthenticated.
   */
  static async load(options: PrSessionLoadOptions): Promise<PrSession> {
    const { owner, repo, number, storageDir } = options;
    const model = options.agentModel ?? DEFAULT_MODEL;
    const progress = options.onProgress ?? (() => undefined);
    const gh = options.gh ?? new GhClient();
    const agent = options.agent ?? new ClaudeAgent();

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

    const session = new PrSession({
      meta,
      files,
      digest,
      model,
      review: null,
      reviewError: null,
      reviewed,
      chatHistory,
      gh,
      agent,
      cache,
      kv,
    });

    await session.#runReview({ bypassCache: false, progress });
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
      review: fixture.review,
      reviewError: null,
      reviewed: new Set<string>(),
      chatHistory: [],
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
   * Re-run the AI review, bypassing the content-hash cache (the
   * "ARGUS: Regenerate Review" command). Fires {@link onDidChangeReview}.
   */
  async regenerate(): Promise<void> {
    await this.#runReview({ bypassCache: true });
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
   * Run the review pipeline into {@link review} / {@link reviewError}, then fire
   * {@link onDidChangeReview}. On a cache hit (unless bypassed) claude is
   * skipped. A missing or failing claude sets an actionable `reviewError` and
   * leaves `review` null — it never fabricates an empty successful review.
   */
  async #runReview(opts: {
    bypassCache: boolean;
    progress?: (message: string) => void;
  }): Promise<void> {
    const progress = opts.progress ?? (() => undefined);
    this.#reviewError = null;

    const cacheKey = this.#cache?.hash(
      stableStringify({
        headSha: this.#meta.headSha,
        digest: this.#digest,
        model: this.#model,
      }),
    );

    if (!opts.bypassCache && this.#cache && cacheKey) {
      const hit = await this.#cache.get(cacheKey);
      if (hit) {
        this.#setReview(hit);
        return;
      }
    }

    if (!this.#agent || !(await this.#agent.isAvailable())) {
      this.#setReviewError(
        'Claude Code (`claude`) was not found, so no AI review was generated. ' +
          'Install Claude Code and confirm `claude --version` runs, then use ' +
          '“ARGUS: Regenerate Review”. The diff is still available without AI.',
      );
      return;
    }

    progress('Generating AI review…');
    try {
      const prompt = buildReviewPrompt(this.#meta, this.#digest);
      const result = await this.#agent.runStructured<ReviewResult>(
        prompt,
        reviewSchema,
        {
          model: this.#model,
          onModelFallback: (fallback, original) =>
            progress(`Model ${original} unavailable; retried with ${fallback}.`),
        },
      );
      const normalized = normalizeReview(
        result.data,
        this.#files,
        this.#digest.aliasToHunkId,
      );
      this.#setReview(normalized);
      if (this.#cache && cacheKey) await this.#cache.set(cacheKey, normalized);
    } catch (error) {
      this.#setReviewError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  #setReview(review: NormalizedReview): void {
    this.#review = review;
    this.#reviewError = null;
    this.#onDidChangeReview.fire();
  }

  #setReviewError(message: string): void {
    this.#review = null;
    this.#reviewError = message;
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
