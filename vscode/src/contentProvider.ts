/**
 * `argus://` virtual-document provider backing the native diff editor.
 *
 * Serves the base- and head-side text of a PR's files so VS Code's built-in
 * diff editor can render them. Contents are fetched lazily through
 * {@link PrSession.fileContents} (engine `gh.fetchBlob`) and memoised per
 * session. A file absent on a side (added on head / deleted on base) yields an
 * empty document so added/deleted files diff cleanly; a fetch failure yields a
 * small error banner document rather than throwing into VS Code.
 *
 * URI shape: `argus://<side>/<owner>/<repo>/<number>/<path>?sha=<sha>`.
 *
 * @module
 */

import * as vscode from 'vscode';

import type { BlobSide, SessionAccessor } from './prSession';

/** The URI scheme this provider is registered for. */
export const ARGUS_SCHEME = 'argus';

/** Command id the tree (or anyone) invokes to open a file's diff. */
export const OPEN_DIFF_COMMAND = 'argus.openDiff';

/* -------------------------------------------------------------------------- */
/* Pure URI helpers                                                           */
/* -------------------------------------------------------------------------- */

/** The decoded fields carried by an `argus://` URI. */
export interface ArgusUriParts {
  readonly side: BlobSide;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /** The side-appropriate file path (base uses the pre-rename path). */
  readonly path: string;
  /** The revision SHA this side was pinned to (uniqueness / cache key only). */
  readonly sha: string;
}

/**
 * Build an `argus://` URI encoding a side, PR identity, file path, and SHA.
 * The SHA lives in the query so that the same file at a different revision is a
 * distinct document (and open diffs re-fetch when it changes).
 */
export function buildArgusUri(parts: ArgusUriParts): vscode.Uri {
  const segments = [
    parts.owner,
    parts.repo,
    String(parts.number),
    ...parts.path.split('/'),
  ].map((s) => encodeURIComponent(s));
  return vscode.Uri.from({
    scheme: ARGUS_SCHEME,
    authority: parts.side,
    path: `/${segments.join('/')}`,
    query: `sha=${encodeURIComponent(parts.sha)}`,
  });
}

/**
 * Decode an `argus://` URI back into its parts. Throws if the URI is not a
 * well-formed argus document URI.
 */
export function parseArgusUri(uri: vscode.Uri): ArgusUriParts {
  const side = uri.authority;
  if (side !== 'base' && side !== 'head') {
    throw new Error(`Not an argus document URI (bad side): ${uri.toString()}`);
  }
  const segments = uri.path.replace(/^\//, '').split('/').map(decodeURIComponent);
  if (segments.length < 4) {
    throw new Error(`Not an argus document URI (short path): ${uri.toString()}`);
  }
  const owner = segments[0] as string;
  const repo = segments[1] as string;
  const number = Number(segments[2]);
  if (!Number.isInteger(number)) {
    throw new Error(`Not an argus document URI (bad number): ${uri.toString()}`);
  }
  const path = segments.slice(3).join('/');
  const sha = new URLSearchParams(uri.query).get('sha') ?? '';
  return { side, owner, repo, number, path, sha };
}

/**
 * Build the (baseUri, headUri) pair for a changed file. The base side uses the
 * pre-rename path (`oldPath`) so renamed files diff against their original blob;
 * both sides carry their respective pinned SHA.
 */
export function diffUrisForFile(
  meta: { owner: string; repo: string; number: number; baseSha: string; headSha: string },
  file: { path: string; oldPath?: string },
): { base: vscode.Uri; head: vscode.Uri } {
  const basePath = file.oldPath ?? file.path;
  const base = buildArgusUri({
    side: 'base',
    owner: meta.owner,
    repo: meta.repo,
    number: meta.number,
    path: basePath,
    sha: meta.baseSha,
  });
  const head = buildArgusUri({
    side: 'head',
    owner: meta.owner,
    repo: meta.repo,
    number: meta.number,
    path: file.path,
    sha: meta.headSha,
  });
  return { base, head };
}

/**
 * The single source of truth for which `argus://` document a given side of a
 * changed file maps to. Both the diff editor ({@link diffUrisForFile}) and the
 * comment threads ({@link module:comments}) resolve side URIs through here, so a
 * renamed file's base side always uses `oldPath` on both — they can never
 * diverge into a thread that attaches to a never-opened document.
 */
export function argusUriForSide(
  meta: { owner: string; repo: string; number: number; baseSha: string; headSha: string },
  file: { path: string; oldPath?: string },
  side: BlobSide,
): vscode.Uri {
  const { base, head } = diffUrisForFile(meta, file);
  return side === 'base' ? base : head;
}

/** Render the fallback error document shown when a side can't be fetched. */
export function errorBanner(side: BlobSide, path: string, message: string): string {
  return (
    `ARGUS could not load the ${side}-side content for:\n` +
    `  ${path}\n\n` +
    `${message}\n\n` +
    `The diff cannot be shown for this side. This is a load error, not the\n` +
    `file's real content — retry after resolving the issue above.\n`
  );
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Register the base/head content provider and the `argus.openDiff` command.
 *
 * @param context     Extension context (for subscriptions).
 * @param getSession  Lazily resolves the current {@link PrSession} or `null`.
 */
export function registerContentProvider(
  context: vscode.ExtensionContext,
  getSession: SessionAccessor,
): void {
  const onDidChange = new vscode.EventEmitter<vscode.Uri>();
  /** Memoised document text, keyed by full URI string. */
  const cache = new Map<string, string>();
  /** Track session identity so a PR swap invalidates the cache. */
  let lastSession = getSession();

  /** Drop cached content (and refresh open diffs) when the session changes. */
  const syncSession = (): void => {
    const session = getSession();
    if (session === lastSession) return;
    lastSession = session;
    const stale = [...cache.keys()];
    cache.clear();
    for (const key of stale) onDidChange.fire(vscode.Uri.parse(key));
  };

  const provider: vscode.TextDocumentContentProvider = {
    onDidChange: onDidChange.event,
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      syncSession();
      const key = uri.toString();
      const cached = cache.get(key);
      if (cached !== undefined) return cached;

      let parts: ArgusUriParts;
      try {
        parts = parseArgusUri(uri);
      } catch (error) {
        return errorBanner('head', uri.toString(), asMessage(error));
      }

      const session = getSession();
      let text: string;
      if (!session) {
        text = errorBanner(parts.side, parts.path, 'No pull request is loaded.');
      } else {
        try {
          text = await session.fileContents(parts.path, parts.side);
        } catch (error) {
          text = errorBanner(parts.side, parts.path, asMessage(error));
        }
      }
      cache.set(key, text);
      return text;
    },
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ARGUS_SCHEME, provider),
    onDidChange,
    vscode.commands.registerCommand(OPEN_DIFF_COMMAND, (path: unknown) =>
      openDiff(getSession, typeof path === 'string' ? path : undefined),
    ),
  );
}

/**
 * Open the native base-vs-head diff for a file path in the current session.
 * Binary files get an information message instead of a broken diff. Safe to
 * call with an unknown/absent path or with no session loaded.
 */
export async function openDiff(
  getSession: SessionAccessor,
  path: string | undefined,
): Promise<void> {
  const session = getSession();
  if (!session) {
    void vscode.window.showInformationMessage('ARGUS: no pull request is loaded.');
    return;
  }
  if (!path) {
    void vscode.window.showInformationMessage('ARGUS: no file path to open.');
    return;
  }

  const file = session.files.find((f) => f.path === path);
  if (!file) {
    void vscode.window.showInformationMessage(`ARGUS: "${path}" is not in this PR.`);
    return;
  }
  if (file.status === 'binary') {
    void vscode.window.showInformationMessage(
      `ARGUS: "${path}" is a binary file — no text diff to show.`,
    );
    return;
  }

  const { base, head } = diffUrisForFile(session.meta, file);
  const title = `${path} (PR #${session.meta.number})`;
  await vscode.commands.executeCommand('vscode.diff', base, head, title);
}

/** Coerce an unknown thrown value into a human-readable message. */
function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
