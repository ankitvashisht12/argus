/**
 * Per-hunk AI notes and user draft comments via the VS Code Comments API.
 *
 * Two kinds of thread live on the same `argus://` diff documents:
 *
 *  (A) **AI threads** — one collapsed, read-only thread per
 *      {@link AnchoredHunkReview}, authored by "ARGUS AI", carrying two comments:
 *      *why this change* and *look out for*. Rebuilt whenever the session review
 *      changes; stale threads are disposed. Never rendered for an absent/errored
 *      review (contract 19) — we render nothing rather than fake "no findings".
 *
 *  (B) **User draft threads** — the reviewer may open a thread on any line of an
 *      `argus://` document and add / edit / delete their own comments. These are
 *      the input to the GitHub submit flow: {@link getDraftComments} exposes them
 *      to github.ts and {@link clearDrafts} wipes them after a successful submit.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import * as vscode from 'vscode';

import type { AnchoredHunkReview, DiffSide, FileChange, HunkImportance } from '@argus/engine';
import type { PrSession, SessionAccessor } from './prSession';
import { argusUriForSide, parseArgusUri } from './contentProvider';

const execFileAsync = promisify(execFile);

/* -------------------------------------------------------------------------- */
/* Cross-surface exports (consumed by github.ts)                              */
/* -------------------------------------------------------------------------- */

/**
 * Which side of the diff a draft comment sits on. Matches the `argus://`
 * document authority, so github.ts maps `base -> LEFT`, `head -> RIGHT`.
 */
export type DraftSide = 'base' | 'head';

/**
 * A single user draft comment, flattened from the draft-thread registry.
 *
 * Consumed by `github.ts` via {@link getDraftComments} / {@link clearDrafts}
 * (bridged in `extension.ts` at activation).
 */
export interface DraftComment {
  /** Head- or base-side file path the comment targets. */
  readonly path: string;
  /** 1-based line number within the diff document. */
  readonly line: number;
  /** Diff side (`base`/`head`) — maps to GitHub `LEFT`/`RIGHT`. */
  readonly side: DraftSide;
  /** The comment body text (Markdown). */
  readonly body: string;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (URI building / parsing, badges) — no session state           */
/* -------------------------------------------------------------------------- */

/** Map an engine diff side to the `argus://` document authority. */
export function sideToAuthority(side: DiffSide): DraftSide {
  return side === 'old' ? 'base' : 'head';
}

/**
 * Recover `{ path, side }` from an `argus://` diff-document URI, or `null`.
 * Delegates to {@link parseArgusUri} so the encoding stays byte-for-byte
 * identical to what `contentProvider.ts` opens in the diff editor.
 */
export function parseDiffUri(uri: vscode.Uri): { path: string; side: DraftSide } | null {
  if (uri.scheme !== 'argus') return null;
  try {
    const parts = parseArgusUri(uri);
    return { path: parts.path, side: parts.side };
  } catch {
    return null;
  }
}

/** Leading badge emoji for an importance (only critical is badged). */
export function importanceBadge(importance: HunkImportance): string {
  return importance === 'critical' ? '\u{1F534} ' : '';
}

/** Markdown body for the "why this change" AI comment. */
export function whyBody(anchor: AnchoredHunkReview): vscode.MarkdownString {
  const md = new vscode.MarkdownString(
    `${importanceBadge(anchor.importance)}**Why this change**\n\n${anchor.why}`,
  );
  md.supportThemeIcons = true;
  return md;
}

/** Markdown body for the skeptic "look out for" AI comment. */
export function lookoutBody(anchor: AnchoredHunkReview): vscode.MarkdownString {
  const md = new vscode.MarkdownString(`**Look out for**\n\n${anchor.lookout}`);
  md.supportThemeIcons = true;
  return md;
}

/**
 * The `argus://` document an AI thread must attach to, resolved the same way the
 * diff editor resolves the file's sides. Crucially, an `old`-side anchor on a
 * renamed file resolves through the file's `oldPath` (like the base diff
 * document) rather than the anchor's head `path`; otherwise the thread would
 * attach to a document that is never opened and the note would be invisible.
 *
 * Returns `null` when the anchor's file is not in the session (nothing to open).
 */
export function aiThreadUri(
  meta: { owner: string; repo: string; number: number; baseSha: string; headSha: string },
  files: readonly FileChange[],
  anchor: AnchoredHunkReview,
): vscode.Uri | null {
  const file = files.find((f) => f.path === anchor.path);
  if (!file) return null;
  return argusUriForSide(meta, file, sideToAuthority(anchor.side));
}

/**
 * The single-line diff-editor range an AI thread attaches to.
 *
 * The engine anchors each note to the hunk's FIRST added/changed line
 * (`startLine === endLine`, 1-based). We build a zero-width, single-line range
 * from `startLine` (converted to 0-based). Anchoring to a single line is
 * deliberate: a CommentThread whose range spans multiple lines has VS Code
 * render its gutter marker / expansion at the range's END line, so a whole-hunk
 * range would push the note to the BOTTOM of the hunk instead of onto the change.
 */
export function aiThreadRange(anchor: AnchoredHunkReview): vscode.Range {
  const line = Math.max(0, anchor.startLine - 1); // 1-based (engine) -> 0-based
  return new vscode.Range(line, 0, line, 0);
}

/* -------------------------------------------------------------------------- */
/* Comment model                                                              */
/* -------------------------------------------------------------------------- */

const AI_AUTHOR: vscode.CommentAuthorInformation = { name: 'ARGUS AI' };

let nextCommentId = 1;

/** A user-authored draft comment; `parent` lets menu commands find its thread. */
class DraftCommentImpl implements vscode.Comment {
  readonly id = nextCommentId++;
  contextValue = 'draft';
  savedBody: string | vscode.MarkdownString;

  constructor(
    public body: string | vscode.MarkdownString,
    public mode: vscode.CommentMode,
    public author: vscode.CommentAuthorInformation,
    public readonly parent: vscode.CommentThread,
  ) {
    this.savedBody = body;
  }
}

function bodyText(body: string | vscode.MarkdownString): string {
  return typeof body === 'string' ? body : body.value;
}

/* -------------------------------------------------------------------------- */
/* Module state (registerComments is called exactly once at activation)       */
/* -------------------------------------------------------------------------- */

let controller: vscode.CommentController | undefined;
let accessor: SessionAccessor | undefined;

/** Session the AI threads currently reflect + its review subscription. */
let boundSession: PrSession | null = null;
let reviewSub: vscode.Disposable | undefined;

/** AI threads currently rendered (disposed and rebuilt on review change). */
const aiThreads: vscode.CommentThread[] = [];

/** User draft threads -> their anchoring file/side (line read live from range). */
const draftRegistry = new Map<vscode.CommentThread, { path: string; side: DraftSide }>();

/** Display name for user comments; resolved from git, falls back to "You". */
let gitUserName = 'You';

/**
 * Fires whenever the set/contents of user draft comments changes (create, edit-
 * save, delete, or bulk clear/discard). Surfaces outside this module — notably
 * the "Submit Review" status-bar item — use it to keep a live draft count without
 * polling. Additive and independent of AI thread anchoring.
 */
const draftsChangedEmitter = new vscode.EventEmitter<void>();
export const onDidChangeDrafts = draftsChangedEmitter.event;

function fireDraftsChanged(): void {
  draftsChangedEmitter.fire();
}

/* -------------------------------------------------------------------------- */
/* AI thread lifecycle                                                        */
/* -------------------------------------------------------------------------- */

function disposeAiThreads(): void {
  for (const thread of aiThreads) thread.dispose();
  aiThreads.length = 0;
}

function createAiThread(session: PrSession, anchor: AnchoredHunkReview): void {
  if (!controller) return;
  const uri = aiThreadUri(session.meta, session.files, anchor);
  if (!uri) return;

  const range = aiThreadRange(anchor);

  const why: vscode.Comment = {
    body: whyBody(anchor),
    mode: vscode.CommentMode.Preview,
    author: AI_AUTHOR,
    contextValue: 'ai',
  };
  const lookout: vscode.Comment = {
    body: lookoutBody(anchor),
    mode: vscode.CommentMode.Preview,
    author: AI_AUTHOR,
    contextValue: 'ai',
  };

  const thread = controller.createCommentThread(uri, range, [why, lookout]);
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
  thread.canReply = false; // read-only AI thread
  thread.contextValue = anchor.importance; // for styling (critical/normal/context)
  thread.label = `ARGUS · ${anchor.importance}`;
  aiThreads.push(thread);
}

/**
 * Rebuild every AI thread from the bound session's review. Renders nothing when
 * the review is absent or errored (contract 19) — the error is surfaced by other
 * surfaces, not faked here as an empty successful review.
 */
function rebuildAiThreads(): void {
  disposeAiThreads();
  const session = boundSession;
  if (!controller || !session || session.review === null) return;
  for (const file of session.files) {
    for (const anchor of session.anchorsForFile(file.path)) {
      createAiThread(session, anchor);
    }
  }
}

/**
 * Re-bind to the current session if it changed (new "Review PR"), re-subscribe
 * to its review event, and rebuild threads. Idempotent — safe to call often.
 */
function syncSession(): void {
  const session = accessor ? accessor() : null;
  if (session === boundSession) return;
  boundSession = session;
  reviewSub?.dispose();
  reviewSub = session ? session.onDidChangeReview(() => rebuildAiThreads()) : undefined;
  // A session swap invalidates every draft by definition: their {path, line}
  // anchor points at the *previous* PR's diff, so submitting them against the
  // new PR would mis-anchor or be rejected. Discard them (and tell the user).
  discardDraftsOnSessionSwap();
  rebuildAiThreads();
}

/**
 * Drop every user draft thread because the session was replaced, warning the
 * user (non-blocking) when drafts were actually discarded. Distinct from
 * {@link clearDrafts}, which is the silent post-submit cleanup.
 */
function discardDraftsOnSessionSwap(): void {
  const discarded = getDraftComments().length;
  if (draftRegistry.size === 0) return;
  clearDrafts();
  if (discarded === 0) return;
  void vscode.window.showInformationMessage(
    `ARGUS: discarded ${discarded} draft review ` +
      `comment${discarded === 1 ? '' : 's'} from the previous pull request.`,
  );
}

/* -------------------------------------------------------------------------- */
/* User draft thread commands                                                 */
/* -------------------------------------------------------------------------- */

function replaceComment(
  thread: vscode.CommentThread,
  target: DraftCommentImpl,
  mutate: (c: DraftCommentImpl) => void,
): void {
  thread.comments = thread.comments.map((c) => {
    if (c instanceof DraftCommentImpl && c.id === target.id) mutate(c);
    return c;
  });
}

function createDraft(reply: vscode.CommentReply): void {
  const thread = reply.thread;
  const meta = parseDiffUri(thread.uri);
  if (!meta) return;

  const comment = new DraftCommentImpl(
    new vscode.MarkdownString(reply.text),
    vscode.CommentMode.Preview,
    { name: gitUserName },
    thread,
  );
  thread.comments = [...thread.comments, comment];
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  thread.label = 'Your review comment';
  if (!draftRegistry.has(thread)) draftRegistry.set(thread, meta);
  fireDraftsChanged();
}

function editDraft(comment: DraftCommentImpl): void {
  const thread = comment.parent;
  replaceComment(thread, comment, (c) => {
    c.mode = vscode.CommentMode.Editing;
  });
}

function saveDraft(comment: DraftCommentImpl): void {
  const thread = comment.parent;
  replaceComment(thread, comment, (c) => {
    c.savedBody = c.body;
    c.mode = vscode.CommentMode.Preview;
  });
  fireDraftsChanged();
}

function cancelEditDraft(comment: DraftCommentImpl): void {
  const thread = comment.parent;
  replaceComment(thread, comment, (c) => {
    c.body = c.savedBody;
    c.mode = vscode.CommentMode.Preview;
  });
}

function deleteDraft(comment: DraftCommentImpl): void {
  const thread = comment.parent;
  thread.comments = thread.comments.filter(
    (c) => !(c instanceof DraftCommentImpl && c.id === comment.id),
  );
  if (thread.comments.length === 0) {
    draftRegistry.delete(thread);
    thread.dispose();
  }
  fireDraftsChanged();
}

/* -------------------------------------------------------------------------- */
/* Public draft accessors (for github.ts)                                     */
/* -------------------------------------------------------------------------- */

/** All user draft comments, flattened across every draft thread. */
export function getDraftComments(): DraftComment[] {
  const out: DraftComment[] = [];
  for (const [thread, meta] of draftRegistry) {
    const line = (thread.range?.start.line ?? 0) + 1; // 1-based
    for (const comment of thread.comments) {
      if (!(comment instanceof DraftCommentImpl)) continue;
      const body = bodyText(comment.body).trim();
      if (!body) continue;
      out.push({ path: meta.path, line, side: meta.side, body });
    }
  }
  return out;
}

/** Drop every user draft thread (call after a successful GitHub submit). */
export function clearDrafts(): void {
  for (const thread of draftRegistry.keys()) thread.dispose();
  draftRegistry.clear();
  fireDraftsChanged();
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Register the comment controller.
 *
 * Contract (design spec + contract 14, 17):
 * - Create a {@link vscode.CommentController} scoped to the `argus` diff docs.
 * - For each entry from {@link PrSession.anchorsForFile}, create a COLLAPSED
 *   comment thread on the anchored `argus://head` (or `argus://base` for pure
 *   deletions) document at the single first-changed line (`startLine`), so the
 *   note renders on the change rather than at the hunk end, containing two AI
 *   comments:
 *   "why this change" and "look out for", labelled with the hunk `importance`
 *   (critical/normal/context). AI comments are read-only (distinct author).
 * - Let the user add their own reply/thread on any diff line, and edit/delete
 *   their own drafts (`commentingRangeProvider` + reply handler). User drafts
 *   are the input to the GitHub submit flow (see github.ts).
 * - Rebuild threads on {@link PrSession.onDidChangeReview}; never render an
 *   errored/absent review as "no findings" — show nothing (the error surfaces
 *   elsewhere) rather than empty success.
 * - Push all disposables onto `context.subscriptions`.
 *
 * @param context     Extension context (for subscriptions).
 * @param getSession  Lazily resolves the current {@link PrSession} or `null`.
 */
export function registerComments(
  context: vscode.ExtensionContext,
  getSession: SessionAccessor,
): void {
  accessor = getSession;

  controller = vscode.comments.createCommentController('argus', 'ARGUS');
  controller.options = {
    prompt: 'Add a review comment on this line',
    placeHolder: 'Draft a review comment — submit them all with “Submit Review to GitHub”',
  };
  // (B) Allow a draft thread on ANY line of an argus:// diff document. The `+`
  // commenting affordance (gutter) is enabled for the full line range so the
  // reviewer can start a draft anywhere in the diff, not just on changed hunks.
  controller.commentingRangeProvider = {
    provideCommentingRanges(document: vscode.TextDocument) {
      if (document.uri.scheme !== 'argus') return [];
      const last = Math.max(0, document.lineCount - 1);
      return [new vscode.Range(0, 0, last, 0)];
    },
  };
  context.subscriptions.push(controller);

  // Draft thread command handlers. These id's must be wired into package.json
  // `contributes` (see the integrator note in the return summary).
  const cmd = (id: string, handler: (arg: never) => void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler as never));
  };
  cmd('argus.createComment', (reply: vscode.CommentReply) => createDraft(reply));
  cmd('argus.editComment', (comment: DraftCommentImpl) => editDraft(comment));
  cmd('argus.saveComment', (comment: DraftCommentImpl) => saveDraft(comment));
  cmd('argus.cancelEditComment', (comment: DraftCommentImpl) => cancelEditDraft(comment));
  cmd('argus.deleteComment', (comment: DraftCommentImpl) => deleteDraft(comment));

  // (A) Bind to the current session (if any) and re-bind when it is replaced.
  // A new "Review PR" swaps the session behind `getSession`; opening its diff
  // makes editors visible, which is our natural re-sync trigger. Regenerate
  // fires onDidChangeReview on the same (already bound) session.
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => syncSession()),
    vscode.window.onDidChangeActiveTextEditor(() => syncSession()),
    new vscode.Disposable(() => {
      reviewSub?.dispose();
      disposeAiThreads();
      clearDrafts();
    }),
  );
  syncSession();

  // Resolve the git user name for draft authorship (best-effort, async).
  void resolveGitUserName();
}

/**
 * Force a re-bind to the current session and rebuild of AI threads.
 *
 * INTEGRATOR (optional): the surface already re-syncs on editor visibility
 * changes, which covers the normal "Review PR opens a diff" path. If you drive
 * a flow that swaps the session without opening/among editors, call this after
 * assigning `currentSession` to refresh threads deterministically.
 */
export function refreshCommentsSession(): void {
  syncSession();
}

async function resolveGitUserName(): Promise<void> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  try {
    const { stdout } = await execFileAsync('git', ['config', 'user.name'], { cwd });
    const name = stdout.trim();
    if (name) gitUserName = name;
  } catch {
    // Leave the "You" fallback in place.
  }
}
