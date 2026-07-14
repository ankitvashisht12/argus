/**
 * Submit-review-to-GitHub flow and the "Review PR…" input flow.
 *
 * This module owns two user-facing flows:
 *
 *  1. **Submit review** (`argus.submitReview`, registered by
 *     {@link registerGitHub}): gather the user's draft comment threads, pick a
 *     review event (comment / approve / request changes), optionally add a
 *     top-level body, confirm, and POST the review through the engine
 *     {@link GhClient.submitReview}.
 *  2. **Review-PR input** ({@link promptPrInput} + the pure {@link parsePrInput}):
 *     accept a GitHub PR URL or `owner/repo` + number, validate it with a quick
 *     `prMeta` probe, and return the identity for the integrator's session
 *     loader (`argus.reviewPr`).
 *
 * Draft comments come from `comments.ts`: this module defines the
 * {@link DraftComment} shape it consumes, and `extension.ts` bridges the two
 * surfaces at activation via the one-time {@link connectDrafts} hook.
 *
 * @module
 */

import * as vscode from 'vscode';

import { GhClient, GhError, PendingReviewError } from '@argus/engine';
import type { DiffSide, ReviewComment, ReviewEvent } from '@argus/engine';

import type { SessionAccessor } from './prSession';

/* -------------------------------------------------------------------------- */
/* Cross-surface contract: draft comments from comments.ts                     */
/* -------------------------------------------------------------------------- */

/**
 * A single user-authored draft comment collected from the Comments API surface
 * (`comments.ts`). Uses the engine's diff-relative {@link DiffSide} (`new`/`old`);
 * {@link toReviewComment} maps it to GitHub's `RIGHT`/`LEFT`.
 *
 * NOTE FOR INTEGRATOR: this is the contract `comments.ts` must satisfy. Its
 * `getDraftComments()` should return `DraftComment[]` and it should expose a
 * `clearDrafts()`; wire both into this module once via {@link connectDrafts}.
 */
export interface DraftComment {
  /** File path the comment targets (head-side path). */
  readonly path: string;
  /** 1-based anchor line on {@link side}. */
  readonly line: number;
  /** Diff side the anchor line refers to. */
  readonly side: DiffSide;
  /** For a multi-line comment, the 1-based first line of the range. */
  readonly startLine?: number;
  /** Diff side for {@link startLine}; defaults to {@link side}. */
  readonly startSide?: DiffSide;
  /** Comment body (Markdown). */
  readonly body: string;
}

/** Supplies the current draft comments (empty when none). */
export type DraftCommentsProvider = () => readonly DraftComment[];

/** Clears the submitted drafts after a successful review submission. */
export type ClearDrafts = () => void | Promise<void>;

let draftsProvider: DraftCommentsProvider = () => [];
let clearDraftsFn: ClearDrafts = () => undefined;

/* -------------------------------------------------------------------------- */
/* Submit-review status-bar item (discoverable one-click submit)               */
/* -------------------------------------------------------------------------- */

let submitStatusBar: vscode.StatusBarItem | undefined;
let statusGetSession: SessionAccessor = () => null;

/**
 * Refresh the "Submit Review to GitHub (N)" status-bar item: visible only while
 * a PR session is active, with N = current draft-comment count. Called on session
 * change and whenever drafts change (wired in `extension.ts`), plus right after a
 * successful submit clears the drafts.
 */
export function refreshSubmitStatus(): void {
  if (!submitStatusBar) return;
  if (!statusGetSession()) {
    submitStatusBar.hide();
    return;
  }
  const count = draftsProvider().length;
  submitStatusBar.text = submitStatusText(count);
  submitStatusBar.tooltip =
    count > 0
      ? `Submit ${count} draft review comment${count === 1 ? '' : 's'} to GitHub`
      : 'Submit a review to GitHub (add inline comments from the diff first)';
  submitStatusBar.show();
}

/**
 * Bridge the `comments.ts` surface into the submit flow. The integrator calls
 * this once at activation (after registering comments) with that surface's
 * `getDraftComments` and `clearDrafts`. Until called, the submit flow sees zero
 * drafts, which is a safe no-op default.
 */
export function connectDrafts(
  provider: DraftCommentsProvider,
  clear: ClearDrafts,
): void {
  draftsProvider = provider;
  clearDraftsFn = clear;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (unit-testable, no vscode)                                     */
/* -------------------------------------------------------------------------- */

/** A parsed PR identity from user input. */
export interface ParsedPrInput {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/** Map an engine {@link DiffSide} to GitHub's review-comment side. */
export function toReviewSide(side: DiffSide): 'LEFT' | 'RIGHT' {
  return side === 'old' ? 'LEFT' : 'RIGHT';
}

/**
 * Map a {@link DraftComment} to an engine {@link ReviewComment}, translating the
 * diff side (`new`→`RIGHT`, `old`→`LEFT`) and preserving multi-line anchors.
 */
export function toReviewComment(draft: DraftComment): ReviewComment {
  const comment: ReviewComment = {
    path: draft.path,
    line: draft.line,
    side: toReviewSide(draft.side),
    body: draft.body,
  };
  if (
    typeof draft.startLine === 'number' &&
    draft.startLine !== draft.line
  ) {
    return {
      ...comment,
      startLine: draft.startLine,
      startSide: toReviewSide(draft.startSide ?? draft.side),
    };
  }
  return comment;
}

/** Map a list of drafts to engine review comments. */
export function toReviewComments(
  drafts: readonly DraftComment[],
): ReviewComment[] {
  return drafts.map(toReviewComment);
}

/**
 * Label for the "Submit Review to GitHub" status-bar item. Shows the draft count
 * in parentheses when there is at least one, so the reviewer always sees how many
 * inline comments a submit would include.
 */
export function submitStatusText(draftCount: number): string {
  return draftCount > 0
    ? `$(cloud-upload) Submit Review to GitHub (${draftCount})`
    : `$(cloud-upload) Submit Review to GitHub`;
}

/** The canonical web URL for a PR. */
export function prUrl(id: {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}): string {
  return `https://github.com/${id.owner}/${id.repo}/pull/${id.number}`;
}

/**
 * Parse a PR reference from free-form user input. Accepts, in order:
 *
 *  - a full/partial GitHub PR URL — `https://github.com/owner/repo/pull/123`
 *    (query strings / trailing `/files` etc. are ignored), or the bare
 *    `owner/repo/pull/123` path;
 *  - `owner/repo#123`;
 *  - `owner/repo 123` or `owner/repo/123`.
 *
 * Returns `null` when nothing parses (so callers can show a validation hint).
 * GitHub.com only in v1 — enterprise hosts are out of scope.
 */
export function parsePrInput(input: string): ParsedPrInput | null {
  const s = input.trim();
  if (!s) return null;

  // PR URL (with or without host) or bare owner/repo/pull/<n> path.
  const pull = s.match(
    /(?:^|github\.com\/)([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\b/i,
  );
  if (pull) return build(pull[1], pull[2], pull[3]);

  // owner/repo#123
  const hash = s.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/);
  if (hash) return build(hash[1], hash[2], hash[3]);

  // owner/repo 123  or  owner/repo/123
  const sep = s.match(/^([^/\s]+)\/([^/\s]+)(?:\s+|\/)(\d+)$/);
  if (sep) return build(sep[1], sep[2], sep[3]);

  return null;
}

function build(
  owner: string | undefined,
  repo: string | undefined,
  numberText: string | undefined,
): ParsedPrInput | null {
  if (!owner || !repo || !numberText) return null;
  const number = Number.parseInt(numberText, 10);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const cleanRepo = repo.replace(/\.git$/i, '');
  if (!cleanRepo) return null;
  return { owner, repo: cleanRepo, number };
}

/* -------------------------------------------------------------------------- */
/* Output channel                                                              */
/* -------------------------------------------------------------------------- */

let channel: vscode.OutputChannel | undefined;

function getChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('ARGUS: GitHub');
    context.subscriptions.push(channel);
  }
  return channel;
}

/* -------------------------------------------------------------------------- */
/* Review-PR input flow                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Prompt for a PR reference, parse and validate it against the live `gh`, and
 * resolve to the identity the session loader should open — or `null` if the
 * user cancelled or validation failed (a message is shown in the failure case).
 *
 * The integrator wires this into the `argus.reviewPr` command: on a non-null
 * result, call `PrSession.load({ owner, repo, number, storageDir, … })`.
 *
 * @param gh Injectable client (defaults to a real {@link GhClient}); used for
 *   the quick `prMeta` existence/permission probe.
 */
export async function promptPrInput(
  gh: GhClient = new GhClient(),
): Promise<ParsedPrInput | null> {
  const raw = await vscode.window.showInputBox({
    title: 'ARGUS: Review PR',
    prompt: 'Paste a GitHub PR URL, or enter owner/repo#number',
    placeHolder: 'https://github.com/owner/repo/pull/123  •  owner/repo#123',
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() === '' || parsePrInput(value)
        ? undefined
        : 'Enter a GitHub PR URL or owner/repo#number.',
  });
  if (raw === undefined) return null; // cancelled

  const parsed = parsePrInput(raw);
  if (!parsed) {
    void vscode.window.showErrorMessage(
      `ARGUS: could not read a PR reference from “${raw.trim()}”.`,
    );
    return null;
  }

  try {
    const meta = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ARGUS: locating ${parsed.owner}/${parsed.repo}#${parsed.number}…`,
      },
      () => gh.prMeta(parsed.owner, parsed.repo, parsed.number),
    );
    // Prefer the authoritative identity from gh (handles casing/redirects).
    return {
      owner: meta.owner,
      repo: meta.repo,
      number: meta.number,
    };
  } catch (error) {
    void vscode.window.showErrorMessage(
      `ARGUS: could not open ${parsed.owner}/${parsed.repo}#${parsed.number}. ${describeGhError(error)}`,
    );
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Submit-review flow                                                          */
/* -------------------------------------------------------------------------- */

interface EventChoice extends vscode.QuickPickItem {
  readonly event: ReviewEvent;
}

const EVENT_CHOICES: readonly EventChoice[] = [
  {
    label: '$(comment) Comment',
    description: 'Leave feedback without explicit approval',
    event: 'COMMENT',
  },
  {
    label: '$(check) Approve',
    description: 'Approve these changes',
    event: 'APPROVE',
  },
  {
    label: '$(request-changes) Request changes',
    description: 'Block the PR until changes are made',
    event: 'REQUEST_CHANGES',
  },
];

function eventLabel(event: ReviewEvent): string {
  switch (event) {
    case 'APPROVE':
      return 'Approve';
    case 'REQUEST_CHANGES':
      return 'Request changes';
    default:
      return 'Comment';
  }
}

/**
 * Run the interactive submit-review flow. Exported (beyond the register hook) so
 * the command handler and any future entry point share one implementation.
 */
export async function submitReviewFlow(
  context: vscode.ExtensionContext,
  getSession: SessionAccessor,
  gh: GhClient = new GhClient(),
): Promise<void> {
  const session = getSession();
  if (!session) {
    void vscode.window.showInformationMessage(
      'ARGUS: load a PR first (run “ARGUS: Review PR…”).',
    );
    return;
  }
  const { owner, repo, number } = session.meta;

  const drafts = [...draftsProvider()];
  const comments = toReviewComments(drafts);

  // 1. Pick the review event.
  const choice = await vscode.window.showQuickPick(EVENT_CHOICES, {
    title: `ARGUS: Submit review to ${owner}/${repo}#${number}`,
    placeHolder:
      drafts.length === 1
        ? '1 draft comment will be included'
        : `${drafts.length} draft comments will be included`,
    ignoreFocusOut: true,
  });
  if (!choice) return; // cancelled

  // 2. Optional top-level body (required for a COMMENT review with no inline
  //    comments — GitHub rejects an empty comment review).
  const bodyRequired = choice.event === 'COMMENT' && drafts.length === 0;
  const body = await vscode.window.showInputBox({
    title: `ARGUS: ${eventLabel(choice.event)} — review summary`,
    prompt: bodyRequired
      ? 'A comment review with no inline comments needs a summary.'
      : 'Optional top-level review comment (Markdown).',
    ignoreFocusOut: true,
    validateInput: (value) =>
      bodyRequired && value.trim() === ''
        ? 'Enter a summary, or add inline comments first.'
        : undefined,
  });
  if (body === undefined) return; // cancelled

  // 3. Modal confirmation.
  const countPhrase =
    drafts.length === 1 ? '1 inline comment' : `${drafts.length} inline comments`;
  const confirmed = await vscode.window.showWarningMessage(
    `Submit a “${eventLabel(choice.event)}” review to ${owner}/${repo}#${number} with ${countPhrase}?`,
    { modal: true, detail: 'This posts to GitHub immediately.' },
    'Submit',
  );
  if (confirmed !== 'Submit') return;

  // 4. Submit.
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ARGUS: submitting review to ${owner}/${repo}#${number}…`,
      },
      () =>
        gh.submitReview(owner, repo, number, {
          event: choice.event,
          body: body.trim(),
          comments,
        }),
    );
  } catch (error) {
    await handleSubmitError(context, error, { owner, repo, number });
    return;
  }

  // 5. Success.
  await clearDraftsFn();
  refreshSubmitStatus();
  const url = prUrl({ owner, repo, number });
  const open = await vscode.window.showInformationMessage(
    `ARGUS: ${eventLabel(choice.event).toLowerCase()} review submitted to ${owner}/${repo}#${number}.`,
    'Open PR',
  );
  if (open === 'Open PR') {
    void vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

/** One-line description of a `gh` failure for inline messages. */
function describeGhError(error: unknown): string {
  if (error instanceof GhError) {
    const firstLine = error.message.split('\n')[0]?.trim();
    return firstLine || `gh exited with code ${error.code}.`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function handleSubmitError(
  context: vscode.ExtensionContext,
  error: unknown,
  id: { owner: string; repo: string; number: number },
): Promise<void> {
  // Pending-review: actionable, its own message already explains the fix.
  if (error instanceof PendingReviewError) {
    const open = await vscode.window.showWarningMessage(
      `ARGUS: ${error.message}`,
      'Open PR',
    );
    if (open === 'Open PR') {
      void vscode.env.openExternal(vscode.Uri.parse(prUrl(id)));
    }
    return;
  }

  // Everything else: concise message + full details in the output channel.
  const out = getChannel(context);
  out.appendLine('--- Submit review failed ---');
  out.appendLine(new Date().toISOString());
  out.appendLine(`PR: ${id.owner}/${id.repo}#${id.number}`);
  if (error instanceof GhError) {
    out.appendLine(`gh exit code: ${error.code}`);
    if (error.stderr.trim()) out.appendLine(error.stderr.trim());
  }
  out.appendLine(error instanceof Error ? (error.stack ?? error.message) : String(error));

  const choice = await vscode.window.showErrorMessage(
    `ARGUS: failed to submit the review. ${describeGhError(error)}`,
    'Show Details',
  );
  if (choice === 'Show Details') out.show(true);
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Register the GitHub submit flow (backs `argus.submitReview`).
 *
 * Registers only `argus.submitReview` here; the `argus.reviewPr` flow is exposed
 * as {@link promptPrInput} for the integrator to call from that command (so the
 * new session can be assigned in `extension.ts`, which owns session lifetime).
 *
 * @param context     Extension context (for subscriptions).
 * @param getSession  Lazily resolves the current {@link PrSession} or `null`.
 */
export function registerGitHub(
  context: vscode.ExtensionContext,
  getSession: SessionAccessor,
): void {
  statusGetSession = getSession;
  submitStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  submitStatusBar.command = 'argus.submitReview';
  refreshSubmitStatus();

  context.subscriptions.push(
    submitStatusBar,
    vscode.commands.registerCommand('argus.submitReview', () =>
      submitReviewFlow(context, getSession),
    ),
  );
}
