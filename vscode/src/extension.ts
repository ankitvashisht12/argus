/**
 * ARGUS extension entry point.
 *
 * Activation creates the single shared session accessor and wires all six visual
 * surfaces (tree, diff content provider, AI + draft comment threads, overview
 * panel, sidebar chat, GitHub submit). It owns the three commands that mutate
 * session lifetime — `argus.reviewPr`, `argus.demo`, `argus.regenerate` — while
 * every other command is registered by the surface that owns it.
 *
 * Error posture (contract 18/19): a missing/unauthenticated `gh` is fatal and
 * surfaces as an actionable notification with install/login buttons; a missing
 * or failing `claude` is non-fatal — the PR still loads (meta + files + diff),
 * `review` stays `null` with `reviewError` set, and the overview shows an error
 * state with Retry.
 *
 * @module
 */

import * as vscode from 'vscode';

import { GhClient } from '@argus/engine';

import { PrSession, ToolUnavailableError } from './prSession';
import type { SessionAccessor } from './prSession';

import { registerContentProvider } from './contentProvider';
import { registerTree, TREE_REFRESH_COMMAND } from './tree';
import {
  registerComments,
  refreshCommentsSession,
  getDraftComments,
  clearDrafts,
  onDidChangeDrafts,
} from './comments';
import { registerOverviewPanel } from './overviewPanel';
import { registerSidebar, notifySidebarSessionChanged } from './sidebar';
import { registerDetails, notifyDetailsSessionChanged } from './details';
import { registerGitHub, promptPrInput, connectDrafts, refreshSubmitStatus } from './github';

/** globalState key: whether the one-time "move chat to the secondary side bar" hint has been shown. */
const CHAT_RELOCATION_HINT_KEY = 'argus.chatRelocationHintShown';

const GH_INSTALL_URL = 'https://cli.github.com';

/**
 * The single loaded PR, shared by every surface. Held here (not in a surface)
 * so the tree, diff, comments, overview, and sidebar all observe the same
 * instance. Replaced wholesale on a new "Review PR"; mutated in place on
 * regenerate/toggle.
 */
let currentSession: PrSession | null = null;

/** Accessor handed to every surface so they read the live session lazily. */
const getSession: SessionAccessor = () => currentSession;

let output: vscode.OutputChannel;

/**
 * "$(sync~spin) ARGUS reviewing…" status-bar item, visible only while the
 * current session's {@link PrSession.reviewStatus} is `'running'`. Distinct from
 * the "Submit Review to GitHub (N)" item owned by github.ts (two items is fine).
 */
let reviewingStatusBar: vscode.StatusBarItem | undefined;

/** Subscription to the current session's review changes; re-bound on adopt. */
let reviewSub: vscode.Disposable | undefined;

/**
 * Activate the extension: create the output channel, wire every surface, and
 * register the session-lifetime commands.
 *
 * @param context Extension context (subscriptions, storage URIs, extensionUri).
 */
export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('ARGUS');
  context.subscriptions.push(output);
  output.appendLine('ARGUS activated.');

  reviewingStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    101, // just left of the submit item (priority 100)
  );
  reviewingStatusBar.text = '$(sync~spin) ARGUS reviewing…';
  reviewingStatusBar.tooltip = 'ARGUS is generating the AI review in the background.';
  context.subscriptions.push(reviewingStatusBar, {
    dispose: () => reviewSub?.dispose(),
  });

  // --- Surfaces (each pushes its own disposables onto context.subscriptions).
  registerContentProvider(context, getSession); // argus:// diff docs + argus.openDiff
  registerTree(context, getSession); // argus.files tree + argus.toggleReviewed
  registerComments(context, getSession); // AI hunk threads + user draft threads
  registerOverviewPanel(context, getSession); // summary/intent/critical/flow webview
  registerDetails(context, getSession); // per-file details webview (activity bar)
  registerSidebar(context, getSession); // chat webview (argus-chat panel container)
  registerGitHub(context, getSession); // argus.submitReview + submit status-bar item

  // Keep the "Submit Review to GitHub (N)" status-bar count live as drafts change.
  context.subscriptions.push(onDidChangeDrafts(() => refreshSubmitStatus()));

  // Bridge the draft comments produced by comments.ts into the submit flow.
  connectDrafts(
    () =>
      getDraftComments().map((d) => ({
        path: d.path,
        line: d.line,
        // comments.ts speaks argus:// document sides (base/head); github.ts
        // speaks engine diff sides (old/new).
        side: d.side === 'base' ? 'old' : 'new',
        body: d.body,
      })),
    clearDrafts,
  );

  // --- Session-lifetime commands (owned here).
  const command = (id: string, handler: () => void | Promise<void>): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => {
        void handler();
      }),
    );
  };

  command('argus.reviewPr', () => reviewPr(context));
  command('argus.demo', () => demo(context));
  command('argus.regenerate', () => regenerate());
}

/** Swap in a freshly loaded session, dispose the old one, refresh every surface. */
function adoptSession(context: vscode.ExtensionContext, session: PrSession): void {
  const previous = currentSession;
  currentSession = session;
  // Re-bind the "reviewing…" indicator + the errored-review toast to the new
  // session's review lifecycle. The review may still be running in the
  // background (progressive load) — surfaces fill in when onDidChangeReview fires.
  reviewSub?.dispose();
  reviewSub = session.onDidChangeReview(() => onReviewChanged(session));
  previous?.dispose();
  refreshSurfaces();
  refreshReviewingStatus();
  maybeSuggestChatRelocation(context);
}

/**
 * React to a review-lifecycle change on the current session: keep the
 * "reviewing…" status-bar item in sync, and — when a review settles into the
 * error state — surface the actionable warning (contract 18/19). Ignores stale
 * events from a session that has since been replaced.
 */
function onReviewChanged(session: PrSession): void {
  if (session !== currentSession) return;
  refreshReviewingStatus();
  if (session.reviewStatus === 'error') notifyReviewState(session);
}

/** Show the spinner while the current review is running; hide it otherwise. */
function refreshReviewingStatus(): void {
  if (!reviewingStatusBar) return;
  if (currentSession?.reviewStatus === 'running') reviewingStatusBar.show();
  else reviewingStatusBar.hide();
}

/** Nudge each lazily-bound surface to re-read the session accessor. */
function refreshSurfaces(): void {
  void vscode.commands.executeCommand(TREE_REFRESH_COMMAND);
  notifySidebarSessionChanged();
  notifyDetailsSessionChanged();
  refreshCommentsSession();
  refreshSubmitStatus();
  // Reveal + rebind the overview so it reflects the new PR immediately.
  void vscode.commands.executeCommand('argus.openOverview');
}

/**
 * One-time guidance toast: the chat lives in the `argus-chat` panel container so
 * the activity-bar container can show Changed Files + File Details. Since VS Code
 * `^1.90` has no stable API to force a view into the secondary side bar (that
 * contribution point only shipped in Aug-2025 Insiders), we let the user relocate
 * it and remember dismissal in globalState so the hint is shown at most once.
 */
function maybeSuggestChatRelocation(context: vscode.ExtensionContext): void {
  if (context.globalState.get<boolean>(CHAT_RELOCATION_HINT_KEY)) return;
  void context.globalState.update(CHAT_RELOCATION_HINT_KEY, true);
  void vscode.window
    .showInformationMessage(
      'ARGUS Chat opens in the bottom panel. Drag its “ARGUS Chat” tab to the ' +
        'Secondary Side Bar to keep chat beside your diff.',
      'Open Chat',
    )
    .then((choice) => {
      if (choice === 'Open Chat') {
        void vscode.commands.executeCommand('argus.sidebar.focus');
      }
    });
}

/**
 * `ARGUS: Review PR…` — preflight `gh`, prompt for the PR reference, fetch the
 * PR (meta + diff, with a progress notification), and adopt the session as soon
 * as the files are ready. The AI review then streams in the background: the
 * "$(sync~spin) ARGUS reviewing…" status-bar item shows while it runs, and a
 * `claude` problem surfaces as a non-fatal warning once it settles (the diff
 * still opens).
 */
async function reviewPr(context: vscode.ExtensionContext): Promise<void> {
  const gh = new GhClient();
  if (!(await ensureGhReady(gh))) return;

  const parsed = await promptPrInput(gh);
  if (!parsed) return;

  await vscode.workspace.fs.createDirectory(context.globalStorageUri);

  let session: PrSession;
  try {
    session = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ARGUS: fetching ${parsed.owner}/${parsed.repo}#${parsed.number}…`,
      },
      (progress) =>
        PrSession.load({
          owner: parsed.owner,
          repo: parsed.repo,
          number: parsed.number,
          storageDir: context.globalStorageUri.fsPath,
          gh,
          onProgress: (message) => progress.report({ message }),
        }),
    );
  } catch (error) {
    await reportLoadError(error);
    return;
  }

  adoptSession(context, session);
  // The AI review runs in the background; its status/errors are surfaced via the
  // "reviewing…" status-bar item and the onDidChangeReview handler (adoptSession).
}

/** `ARGUS: Open Demo Review (fixture)` — load the bundled fixture, no gh/claude. */
async function demo(context: vscode.ExtensionContext): Promise<void> {
  try {
    const session = await PrSession.loadDemo();
    adoptSession(context, session);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `ARGUS: could not open the demo fixture. ${messageOf(error)}`,
    );
  }
}

/**
 * `ARGUS: Regenerate Review` — re-run the AI review, bypassing the cache. Reuses
 * the same background path as the initial load: `reviewStatus` flips to
 * `'running'` (so the "reviewing…" indicator + overview loading state show) and
 * the surfaces refill when it settles via onDidChangeReview. Not awaited here.
 */
function regenerate(): void {
  const session = currentSession;
  if (!session) {
    void vscode.window.showInformationMessage(
      'ARGUS: load a PR first (run “ARGUS: Review PR…”).',
    );
    return;
  }
  void session.regenerate();
}

/**
 * Verify `gh` is installed and authenticated; otherwise show an actionable
 * notification (Install / docs / authenticate hint) and return `false`.
 */
async function ensureGhReady(gh: GhClient): Promise<boolean> {
  if (!(await gh.isAvailable())) {
    const choice = await vscode.window.showErrorMessage(
      'ARGUS: the GitHub CLI (`gh`) was not found. Install it and ensure `gh` is on your PATH.',
      'Install gh',
    );
    if (choice === 'Install gh') {
      void vscode.env.openExternal(vscode.Uri.parse(GH_INSTALL_URL));
    }
    return false;
  }
  if (!(await gh.isAuthed())) {
    void vscode.window.showErrorMessage(
      'ARGUS: the GitHub CLI is not authenticated. Run `gh auth login` in a terminal, then retry.',
    );
    return false;
  }
  return true;
}

/** Turn a load failure into an actionable notification. */
async function reportLoadError(error: unknown): Promise<void> {
  if (error instanceof ToolUnavailableError && error.tool === 'gh') {
    if (error.reason === 'missing') {
      const choice = await vscode.window.showErrorMessage(
        `ARGUS: ${error.message}`,
        'Install gh',
      );
      if (choice === 'Install gh') {
        void vscode.env.openExternal(vscode.Uri.parse(GH_INSTALL_URL));
      }
      return;
    }
    void vscode.window.showErrorMessage(`ARGUS: ${error.message}`);
    return;
  }
  void vscode.window.showErrorMessage(
    `ARGUS: could not load the pull request. ${messageOf(error)}`,
  );
}

/**
 * After a load/regenerate, surface the AI-review state: a `reviewError` becomes
 * a non-fatal warning with a Regenerate action (the diff still works).
 */
function notifyReviewState(session: PrSession): void {
  if (session.review === null && session.reviewError) {
    output.appendLine(`Review unavailable: ${session.reviewError}`);
    void vscode.window
      .showWarningMessage(`ARGUS: ${session.reviewError}`, 'Regenerate')
      .then((choice) => {
        if (choice === 'Regenerate') {
          void vscode.commands.executeCommand('argus.regenerate');
        }
      });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Deactivate: dispose the current session, if any. */
export function deactivate(): void {
  currentSession?.dispose();
  currentSession = null;
}
