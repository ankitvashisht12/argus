/**
 * Overview webview panel: summary / intent / critical / flow + PR header + files.
 *
 * A singleton {@link vscode.WebviewPanel} that renders {@link PrSession.overview}
 * with a reviewer-skeptic lens. It has four render states, driven purely from
 * session getters (see {@link buildOverviewModel}):
 *
 *   - `empty`   — no PR loaded yet (friendly call to action).
 *   - `loading` — a PR is loaded but the AI review has not resolved yet.
 *   - `error`   — {@link PrSession.reviewError} is set: shows the actionable
 *                 message + a Retry button wired to `argus.regenerate`. This is
 *                 NEVER rendered as an empty "no findings" success (contract 19).
 *   - `ready`   — {@link PrSession.review} is present: full overview render.
 *
 * The webview is strict-CSP (no external origins, nonce'd inline bootstrap +
 * nonce'd local script, styles from `webview.cspSource`) and theme-aware via
 * `var(--vscode-*)` tokens, so it works in light and dark themes (contract 20).
 * Clicking a file row posts a message that runs `argus.openDiff` for that path.
 * Renders identically from the bundled demo fixture (contract 15).
 *
 * @module
 */

import { readFileSync } from 'node:fs';

import * as vscode from 'vscode';

import type { FileReview, FileStatus } from '@argus/engine';

import type { PrSession, SessionAccessor } from './prSession';

/* -------------------------------------------------------------------------- */
/* View model (pure)                                                           */
/* -------------------------------------------------------------------------- */

/** Which of the four render states the overview should show. */
export type OverviewState = 'empty' | 'loading' | 'error' | 'ready';

/** One row of the Files section. */
export interface OverviewFileVM {
  /** Head-side path of the file. */
  readonly path: string;
  /** The file's role in the change (from the per-file review), or `''`. */
  readonly role: string;
  /** Short per-file note, or `''`. */
  readonly note: string;
  /** Change classification. */
  readonly status: FileStatus;
  /** Added line count. */
  readonly additions: number;
  /** Deleted line count. */
  readonly deletions: number;
  /** Whether the user has marked this file reviewed. */
  readonly reviewed: boolean;
}

/**
 * The fully-resolved payload posted to the webview. Everything the webview needs
 * to render, with no live VS Code objects — pure data, so it can be built and
 * asserted on without an extension host.
 */
export interface OverviewModel {
  readonly state: OverviewState;
  /** PR title (empty in the `empty` state). */
  readonly prTitle: string;
  /** PR author login. */
  readonly author: string;
  /** PR number (0 in the `empty` state). */
  readonly number: number;
  /** `owner/repo` slug. */
  readonly repo: string;
  /** Canonical GitHub PR URL (empty in the `empty` state). */
  readonly url: string;
  /** Plain-language summary (`ready` only). */
  readonly summary: string;
  /** Skeptic-inferred intent (`ready` only) — the anchor of the review. */
  readonly intent: string;
  /** Critical things to verify (`ready` only). */
  readonly critical: readonly string[];
  /** Ordered read-order narrative (`ready` only). */
  readonly flow: readonly string[];
  /** File rows (`ready` only). */
  readonly files: readonly OverviewFileVM[];
  /**
   * Count of real diff hunks the review never covered (`ready` only). Normally
   * `0` — the schema's `minItems` forces full coverage — so a non-zero value is
   * the honesty backstop surfaced as "N hunks not covered — Regenerate to retry".
   */
  readonly uncoveredCount: number;
  /** Actionable error text (`error` only), else `null`. */
  readonly error: string | null;
}

/**
 * Canonical GitHub URL for a PR. Pure; exported so the header link and any tests
 * share one definition.
 */
export function prGitHubUrl(owner: string, repo: string, number: number): string {
  return `https://github.com/${owner}/${repo}/pull/${number}`;
}

/**
 * Derive the {@link OverviewModel} from the current session. Pure w.r.t. the
 * session getters — no side effects, no VS Code objects — so the four states are
 * unit-checkable. Encodes contract 19: `reviewError` beats a missing review, and
 * a missing review is `loading`, never a fabricated empty success.
 */
export function buildOverviewModel(session: PrSession | null): OverviewModel {
  const blank: OverviewModel = {
    state: 'empty',
    prTitle: '',
    author: '',
    number: 0,
    repo: '',
    url: '',
    summary: '',
    intent: '',
    critical: [],
    flow: [],
    files: [],
    uncoveredCount: 0,
    error: null,
  };

  if (!session) return blank;

  const meta = session.meta;
  const base = {
    ...blank,
    prTitle: meta.title,
    author: meta.author,
    number: meta.number,
    repo: `${meta.owner}/${meta.repo}`,
    url: prGitHubUrl(meta.owner, meta.repo, meta.number),
  };

  // Error beats absence (contract 19).
  if (session.reviewError) {
    return { ...base, state: 'error', error: session.reviewError };
  }

  const overview = session.overview;
  if (!overview) {
    return { ...base, state: 'loading' };
  }

  const files: OverviewFileVM[] = session.files.map((file) => {
    const fr: FileReview | undefined = session.fileReview(file.path);
    return {
      path: file.path,
      role: fr?.role ?? '',
      note: fr?.note ?? '',
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      reviewed: session.isReviewed(file.path),
    };
  });

  return {
    ...base,
    state: 'ready',
    summary: overview.summary,
    intent: overview.intent,
    critical: overview.critical,
    flow: overview.flow,
    files,
    uncoveredCount: session.review?.uncoveredHunkIds.length ?? 0,
  };
}

/* -------------------------------------------------------------------------- */
/* HTML shell (pure)                                                           */
/* -------------------------------------------------------------------------- */

/** A cryptographically-arbitrary nonce for the CSP + script tag. */
export function makeNonce(): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

/**
 * Substitute the `%%TOKEN%%` placeholders in the `media/overview.html` template.
 * Pure string→string so the CSP/nonce/URI wiring can be asserted without a
 * webview. The template owns the markup; this only injects trusted values
 * (webview resource URIs, the CSP source, and the nonce).
 */
export function buildOverviewHtml(
  template: string,
  values: {
    readonly cspSource: string;
    readonly nonce: string;
    readonly styleUri: string;
    readonly scriptUri: string;
  },
): string {
  return template
    .replaceAll('%%CSP_SOURCE%%', values.cspSource)
    .replaceAll('%%NONCE%%', values.nonce)
    .replaceAll('%%STYLE_URI%%', values.styleUri)
    .replaceAll('%%SCRIPT_URI%%', values.scriptUri);
}

/* -------------------------------------------------------------------------- */
/* Message protocol                                                            */
/* -------------------------------------------------------------------------- */

/** Extension → webview. */
type ToWebview = { readonly type: 'render'; readonly model: OverviewModel };

/** Webview → extension. */
type FromWebview =
  | { readonly type: 'ready' }
  | { readonly type: 'openDiff'; readonly path: string }
  | { readonly type: 'regenerate' };

/**
 * Command the Files section asks the host to run for a clicked file. NOT declared
 * by any surface stub, so it is declared here as this surface's contract: the
 * integrator must register `argus.openDiff` (a single string `path` arg) that
 * opens the native base-vs-head diff — the contentProvider stub is the natural
 * home. Until it exists, clicking a file is a no-op (the command is absent).
 */
const OPEN_DIFF_COMMAND = 'argus.openDiff';

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Register / open the overview panel. See the module doc for the render-state
 * contract. Owns a singleton panel (revealed if already open) and re-renders on
 * {@link PrSession.onDidChangeReview} / {@link PrSession.onDidChangeReviewedState},
 * rebinding those listeners whenever the shared session instance is replaced.
 *
 * @param context     Extension context (for subscriptions + `extensionUri`).
 * @param getSession  Lazily resolves the current {@link PrSession} or `null`.
 */
export function registerOverviewPanel(
  context: vscode.ExtensionContext,
  getSession: SessionAccessor,
): void {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');

  let panel: vscode.WebviewPanel | undefined;
  let boundSession: PrSession | null = null;
  let sessionListeners: vscode.Disposable[] = [];

  const render = (): void => {
    if (!panel) return;
    const session = getSession();
    panel.title = overviewTitle(session);
    const model = buildOverviewModel(session);
    void panel.webview.postMessage({ type: 'render', model } satisfies ToWebview);
  };

  /** (Re)subscribe to the current session's change events; render once. */
  const bindSession = (): void => {
    const session = getSession();
    if (session !== boundSession) {
      for (const d of sessionListeners) d.dispose();
      sessionListeners = [];
      boundSession = session;
      if (session) {
        sessionListeners.push(
          session.onDidChangeReview(() => render()),
          session.onDidChangeReviewedState(() => render()),
        );
      }
    }
    render();
  };

  const buildHtml = (webview: vscode.Webview): string => {
    const template = readFileSync(
      vscode.Uri.joinPath(mediaRoot, 'overview.html').fsPath,
      'utf8',
    );
    return buildOverviewHtml(template, {
      cspSource: webview.cspSource,
      nonce: makeNonce(),
      styleUri: webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'overview.css'))
        .toString(),
      scriptUri: webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'overview.js'))
        .toString(),
    });
  };

  const createOrShow = (): void => {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active;

    if (panel) {
      panel.reveal(column);
      bindSession();
      return;
    }

    panel = vscode.window.createWebviewPanel(
      'argus.overview',
      overviewTitle(getSession()),
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot],
      },
    );

    panel.webview.html = buildHtml(panel.webview);

    panel.webview.onDidReceiveMessage(
      (message: FromWebview) => {
        switch (message.type) {
          case 'ready':
            bindSession();
            break;
          case 'openDiff':
            void vscode.commands.executeCommand(OPEN_DIFF_COMMAND, message.path);
            break;
          case 'regenerate':
            void vscode.commands.executeCommand('argus.regenerate');
            break;
        }
      },
      undefined,
      context.subscriptions,
    );

    panel.onDidDispose(
      () => {
        for (const d of sessionListeners) d.dispose();
        sessionListeners = [];
        boundSession = null;
        panel = undefined;
      },
      undefined,
      context.subscriptions,
    );
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('argus.openOverview', createOrShow),
    { dispose: () => sessionListeners.forEach((d) => d.dispose()) },
  );
}

/** Panel/tab title: `ARGUS Overview — PR #n` (bare when no PR is loaded). */
function overviewTitle(session: PrSession | null): string {
  return session
    ? `ARGUS Overview — PR #${session.meta.number}`
    : 'ARGUS Overview';
}
