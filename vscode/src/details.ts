/**
 * File-details webview view (`argus.details`, primary/activity-bar sidebar).
 *
 * Renders, for the file focused in the active `argus://` diff editor, its path,
 * hunk count, AI role, and note; when no file is focused it shows the PR summary
 * (or an "AI review unavailable" fallback), and an empty-state "Review a PR…"
 * button when no PR is loaded.
 *
 * This surface used to live at the top of the chat webview (`argus.sidebar`); it
 * was split out so the activity-bar container can present "Changed Files" and
 * "File Details" as two sibling accordion views while the chat moves to its own
 * container. The extension host owns all session state; the webview is a dumb
 * renderer fed fully-computed payloads.
 *
 * @module
 */

import * as vscode from 'vscode';

import type { PrSession, SessionAccessor } from './prSession';
import { parseArgusUri } from './sidebar';
import { makeNonce } from './overviewPanel';

/* -------------------------------------------------------------------------- */
/* Pure payload builder (no vscode side effects — unit-testable)               */
/* -------------------------------------------------------------------------- */

/** Payload the webview renders in the details panel. */
export type DetailsPayload =
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'pr';
      readonly title: string;
      readonly subtitle: string;
      readonly summary: string;
    }
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly role: string;
      readonly note: string;
      readonly hunkCount: number;
      readonly reviewed: boolean;
    };

/**
 * Compute the details payload from the current session and focused file. Reads
 * session getters only (no mutation); returns a plain, serializable object safe
 * to `postMessage` into the webview.
 */
export function buildDetails(
  session: PrSession | null,
  focusPath: string | undefined,
): DetailsPayload {
  if (!session) return { kind: 'empty' };

  if (focusPath) {
    const file = session.files.find((f) => f.path === focusPath);
    const review = session.fileReview(focusPath);
    const fallbackNote = review
      ? ''
      : session.reviewError
        ? 'AI review unavailable for this PR.'
        : 'No AI note for this file.';
    return {
      kind: 'file',
      path: focusPath,
      role: review?.role ?? '',
      note: review?.note ?? fallbackNote,
      hunkCount: file?.hunks.length ?? 0,
      reviewed: session.isReviewed(focusPath),
    };
  }

  const meta = session.meta;
  const summary =
    session.overview?.summary ??
    (session.reviewError
      ? 'AI review unavailable — open a changed file to see its diff.'
      : 'Generating review…');
  return {
    kind: 'pr',
    title: meta.title,
    subtitle: `#${meta.number} · ${meta.owner}/${meta.repo} · @${meta.author}`,
    summary,
  };
}

/* -------------------------------------------------------------------------- */
/* Webview <-> host message protocol                                           */
/* -------------------------------------------------------------------------- */

/** Messages the host posts INTO the webview. */
type ToWebview =
  | { readonly type: 'state'; readonly details: DetailsPayload }
  | { readonly type: 'details'; readonly details: DetailsPayload };

/** Messages the webview posts back to the host. */
type FromWebview =
  | { readonly type: 'ready' }
  | { readonly type: 'reviewPr' };

/* -------------------------------------------------------------------------- */
/* Provider                                                                    */
/* -------------------------------------------------------------------------- */

/** The live provider instance, so the integrator can force a resync. */
let activeProvider: DetailsProvider | undefined;

class DetailsProvider implements vscode.WebviewViewProvider {
  #view: vscode.WebviewView | undefined;
  #wiredSession: PrSession | null = null;
  #reviewSub: vscode.Disposable | undefined;
  #focusPath: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getSession: SessionAccessor,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };
    view.webview.html = this.#html(view.webview);

    view.webview.onDidReceiveMessage(
      (msg: FromWebview) => this.#onMessage(msg),
      undefined,
      this.context.subscriptions,
    );
    view.onDidChangeVisibility(
      () => {
        if (view.visible) this.sync();
      },
      undefined,
      this.context.subscriptions,
    );
    view.onDidDispose(() => {
      if (this.#view === view) this.#view = undefined;
    });

    this.sync();
  }

  /** Update the focused file from the active editor and refresh the panel. */
  updateActiveEditor(editor: vscode.TextEditor | undefined): void {
    // When the editor is undefined (e.g. focus moved to a webview) keep the last
    // file focus so details don't flicker back to the PR summary.
    if (!editor) return;
    this.#focusPath = parseArgusUri(editor.document.uri)?.path;
    this.#pushDetails();
  }

  /**
   * Re-resolve the session; if it changed instance, re-wire its review
   * subscription and push a fresh full state to the webview.
   */
  sync(): void {
    const session = this.getSession();
    if (session !== this.#wiredSession) {
      this.#reviewSub?.dispose();
      this.#reviewSub = undefined;
      this.#wiredSession = session;
      if (session) {
        this.#reviewSub = vscode.Disposable.from(
          session.onDidChangeReview(() => this.#pushDetails()),
          session.onDidChangeReviewedState(() => this.#pushDetails()),
        );
      }
    }
    this.#post({
      type: 'state',
      details: buildDetails(session, this.#focusPath),
    });
  }

  dispose(): void {
    this.#reviewSub?.dispose();
    if (activeProvider === this) activeProvider = undefined;
  }

  /* ----------------------------------------------------------------------- */

  #onMessage(msg: FromWebview): void {
    switch (msg.type) {
      case 'ready':
        this.sync();
        break;
      case 'reviewPr':
        void vscode.commands.executeCommand('argus.reviewPr');
        break;
    }
  }

  #pushDetails(): void {
    this.#post({
      type: 'details',
      details: buildDetails(this.getSession(), this.#focusPath),
    });
  }

  #post(message: ToWebview): void {
    void this.#view?.webview.postMessage(message);
  }

  #html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(media, 'details.css'),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(media, 'details.js'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource}`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>File Details</title>
</head>
<body>
  <section id="details" class="details" aria-live="polite"></section>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Force the details view to re-read the session accessor and re-render.
 *
 * INTEGRATOR: call this from `argus.reviewPr` / `argus.demo` right after
 * assigning `currentSession` (and after disposing the old one), mirroring
 * `notifySidebarSessionChanged`. Safe to call before the view is resolved (no-op).
 */
export function notifyDetailsSessionChanged(): void {
  activeProvider?.sync();
}

/**
 * Register the file-details webview view (`argus.details`).
 *
 * @param context     Extension context (for subscriptions + `extensionUri`).
 * @param getSession  Lazily resolves the current {@link PrSession} or `null`.
 */
export function registerDetails(
  context: vscode.ExtensionContext,
  getSession: SessionAccessor,
): void {
  const provider = new DetailsProvider(context, getSession);
  activeProvider = provider;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('argus.details', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) =>
      provider.updateActiveEditor(editor),
    ),
    { dispose: () => provider.dispose() },
  );

  provider.updateActiveEditor(vscode.window.activeTextEditor);
}
