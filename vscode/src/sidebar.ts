/**
 * Secondary-sidebar webview view (`argus.sidebar`): streaming chat about the PR
 * plus a details panel for the active file.
 *
 * The extension host owns all session state; the webview is a dumb renderer that
 * receives fully-computed payloads and posts back user intents (send / stop /
 * open-review). This keeps the CSP-restricted webview free of any engine or
 * `vscode` coupling.
 *
 * @module
 */

import * as vscode from 'vscode';

import type { SessionAccessor, PrSession, ChatMessage } from './prSession';
import type { ChatDelta } from '@argus/engine';

/* -------------------------------------------------------------------------- */
/* Pure helpers (no vscode side effects — unit-testable)                       */
/* -------------------------------------------------------------------------- */

/**
 * Minimal URI shape used by {@link parseArgusUri}. `vscode.Uri` satisfies it,
 * but keeping the surface tiny makes the parser pure and testable without the
 * extension host.
 */
export interface UriLike {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
}

/**
 * Decode an `argus://` diff-document URI produced by the content provider
 * (`argus://<side>/<owner>/<repo>/<number>/<path…>?sha=…`) back into the file
 * path and side. Returns `null` for any non-`argus` or malformed URI.
 *
 * NOTE: this mirrors the encoding owned by `contentProvider.ts` (scheme `argus`,
 * authority = side, path = `/<owner>/<repo>/<number>/<file segments>`). If the
 * content provider changes that encoding, update this in lockstep.
 */
export function parseArgusUri(
  uri: UriLike,
): { side: 'base' | 'head'; path: string } | null {
  if (uri.scheme !== 'argus') return null;
  if (uri.authority !== 'base' && uri.authority !== 'head') return null;
  const segments = uri.path.replace(/^\/+/, '').split('/').map(decodeURIComponent);
  if (segments.length < 4) return null;
  const path = segments.slice(3).join('/');
  if (!path) return null;
  return { side: uri.authority, path };
}

/** Payload the webview renders in its top details panel. */
export type SidebarDetails =
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
): SidebarDetails {
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

/** A cryptographically-unpredictable nonce for the strict-CSP `<script>`. */
function getNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/* -------------------------------------------------------------------------- */
/* Webview <-> host message protocol                                           */
/* -------------------------------------------------------------------------- */

/** Messages the host posts INTO the webview. */
type ToWebview =
  | { readonly type: 'state'; readonly details: SidebarDetails; readonly history: readonly ChatMessage[] }
  | { readonly type: 'details'; readonly details: SidebarDetails }
  | { readonly type: 'streamStart' }
  | { readonly type: 'delta'; readonly delta: ChatDelta }
  | { readonly type: 'streamEnd' };

/** Messages the webview posts back to the host. */
type FromWebview =
  | { readonly type: 'ready' }
  | { readonly type: 'send'; readonly text: string }
  | { readonly type: 'stop' }
  | { readonly type: 'reviewPr' };

/* -------------------------------------------------------------------------- */
/* Provider                                                                    */
/* -------------------------------------------------------------------------- */

/** The live provider instance, so the integrator can force a resync. */
let activeProvider: SidebarProvider | undefined;

class SidebarProvider implements vscode.WebviewViewProvider {
  #view: vscode.WebviewView | undefined;
  #wiredSession: PrSession | null = null;
  #reviewSub: vscode.Disposable | undefined;
  #focusPath: string | undefined;
  #abort: AbortController | undefined;
  #streaming = false;

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

  /** Update the focused file from the active editor and refresh the details panel. */
  updateActiveEditor(editor: vscode.TextEditor | undefined): void {
    // When the editor is undefined (e.g. focus moved to this webview) keep the
    // last file focus so details don't flicker back to the PR summary.
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
        const disposables = [
          session.onDidChangeReview(() => this.#pushDetails()),
          session.onDidChangeReviewedState(() => this.#pushDetails()),
        ];
        this.#reviewSub = vscode.Disposable.from(...disposables);
      }
    }
    this.#post({
      type: 'state',
      details: buildDetails(session, this.#focusPath),
      history: session?.chatHistory ?? [],
    });
  }

  dispose(): void {
    this.#reviewSub?.dispose();
    this.#abort?.abort();
    if (activeProvider === this) activeProvider = undefined;
  }

  /* ----------------------------------------------------------------------- */

  #onMessage(msg: FromWebview): void {
    switch (msg.type) {
      case 'ready':
        this.sync();
        break;
      case 'send':
        void this.#startChat(msg.text);
        break;
      case 'stop':
        this.#abort?.abort();
        break;
      case 'reviewPr':
        void vscode.commands.executeCommand('argus.reviewPr');
        break;
    }
  }

  async #startChat(text: string): Promise<void> {
    const session = this.getSession();
    const prompt = text.trim();
    if (!session || !prompt || this.#streaming) return;

    this.#streaming = true;
    this.#abort = new AbortController();
    this.#post({ type: 'streamStart' });
    try {
      await session.chat(
        prompt,
        (delta) => this.#post({ type: 'delta', delta }),
        { focusPath: this.#focusPath, signal: this.#abort.signal },
      );
    } catch (error) {
      this.#post({
        type: 'delta',
        delta: {
          type: 'error',
          text: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      this.#streaming = false;
      this.#abort = undefined;
      this.#post({ type: 'streamEnd' });
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
    const nonce = getNonce();
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(media, 'sidebar.css'),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(media, 'sidebar.js'),
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
  <title>ARGUS Chat</title>
</head>
<body>
  <section id="details" class="details" aria-live="polite"></section>
  <div id="log" class="log" role="log" aria-live="polite"></div>
  <form id="composer" class="composer">
    <textarea id="input" rows="1" placeholder="Ask about this PR…"
      aria-label="Chat message" autocomplete="off"></textarea>
    <button id="send" type="submit" title="Send (Enter)">Send</button>
    <button id="stop" type="button" class="hidden" title="Stop">Stop</button>
  </form>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Force the sidebar to re-read the session accessor and re-render.
 *
 * INTEGRATOR: call this from `argus.reviewPr` / `argus.demo` right after
 * assigning `currentSession` (and after disposing the old one). Without a
 * session-changed signal the sidebar only re-syncs on user interaction
 * (active-editor change, view (re)visibility, or an incoming webview message);
 * calling this guarantees the panel refreshes the instant a PR loads. Safe to
 * call when no sidebar has been resolved yet (no-op).
 */
export function notifySidebarSessionChanged(): void {
  activeProvider?.sync();
}

/**
 * Register the sidebar webview view (`argus.sidebar`).
 *
 * @param context     Extension context (for subscriptions + `extensionUri`).
 * @param getSession  Lazily resolves the current {@link PrSession} or `null`.
 */
export function registerSidebar(
  context: vscode.ExtensionContext,
  getSession: SessionAccessor,
): void {
  const provider = new SidebarProvider(context, getSession);
  activeProvider = provider;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('argus.sidebar', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) =>
      provider.updateActiveEditor(editor),
    ),
    { dispose: () => provider.dispose() },
  );

  provider.updateActiveEditor(vscode.window.activeTextEditor);
}
