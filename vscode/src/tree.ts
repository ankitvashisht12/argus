/**
 * Changed-files TreeView (`argus.files`, primary sidebar).
 *
 * Presents the loaded PR as a header node plus its changed files grouped by
 * directory (with VS Code-style compact folders). Each file shows a status
 * letter and ±add/delete counts, a status codicon, and — once the user marks it
 * reviewed — a check badge and dimmed label (via a {@link vscode.FileDecorationProvider}).
 * Selecting a file opens the native base↔head diff; a per-item action toggles
 * reviewed state. The provider re-binds and rebuilds whenever the shared session
 * changes and follows the session's review / reviewed-state events.
 *
 * @module
 */

import * as vscode from 'vscode';

import type { FileChange, FileStatus } from '@argus/engine';

import type { PrSession, SessionAccessor } from './prSession';
import { parseArgusUri } from './contentProvider';

/* -------------------------------------------------------------------------- */
/* Command / id contracts                                                     */
/* -------------------------------------------------------------------------- */

/** View id this provider backs (matches `package.json` `contributes.views`). */
export const VIEW_ID = 'argus.files';

/**
 * Command the tree fires to open a file's diff. It is OWNED by
 * `contentProvider.ts` (per its TSDoc: "Expose a helper (or command) that, given
 * a file path, opens `vscode.diff(baseUri, headUri, …)`"). The content provider
 * must `registerCommand(OPEN_DIFF_COMMAND, …)` accepting a single argument:
 *
 *   `arguments: [path: string]` — the head-side path of the file to diff.
 *
 * This module only *invokes* it (via a {@link vscode.TreeItem.command}); it does
 * NOT register it. If the content provider is not yet wired, clicking a file is
 * a harmless no-op error in the log.
 */
export const OPEN_DIFF_COMMAND = 'argus.openDiff';

/**
 * Command that toggles a file's reviewed state. Contributed in `package.json`
 * (`argus.toggleReviewed`) and REGISTERED HERE. It accepts, as its first
 * argument, either a file {@link TreeNode} (when fired from the tree's
 * context/inline menu), a path `string`, or nothing (falls back to the tree
 * selection, then the active `argus://` diff editor).
 *
 * NOTE for the integrator: `extension.ts` currently registers a placeholder
 * `argus.toggleReviewed` handler. Remove that placeholder when wiring
 * {@link registerTree}, otherwise `registerCommand` throws on the duplicate id.
 */
export const TOGGLE_REVIEWED_COMMAND = 'argus.toggleReviewed';

/**
 * Command the integrator should invoke after replacing / clearing the shared
 * session (e.g. at the end of `argus.reviewPr` / `argus.demo`) so the tree
 * re-binds to the new instance and rebuilds:
 *
 *   `await vscode.commands.executeCommand(TREE_REFRESH_COMMAND);`
 *
 * The tree also self-refreshes when its view becomes visible and whenever the
 * bound session fires its events, so this is a belt-and-braces trigger for the
 * moment a *new* session is assigned.
 */
export const TREE_REFRESH_COMMAND = 'argus.tree.refresh';

/**
 * URI scheme used purely as the `resourceUri` of file tree items so the
 * {@link vscode.FileDecorationProvider} can key reviewed decorations off it.
 * Distinct from the `argus://` diff-document scheme owned by the content
 * provider.
 */
export const FILE_URI_SCHEME = 'argus-file';

/* -------------------------------------------------------------------------- */
/* Pure tree model (directory grouping + compact folders)                     */
/* -------------------------------------------------------------------------- */

/** A directory node in the grouped file tree (name may be compacted, e.g. `a/b`). */
export interface FileTreeDir {
  /** Display name — a `/`-joined chain when compacted. */
  readonly name: string;
  /** Full head-side directory path this node represents. */
  readonly path: string;
  /** Child directories, sorted by name. */
  readonly dirs: readonly FileTreeDir[];
  /** Files directly in this directory, in diff order. */
  readonly files: readonly FileChange[];
}

/** Top level of the grouped file tree. */
export interface FileTree {
  readonly dirs: readonly FileTreeDir[];
  readonly files: readonly FileChange[];
}

interface MutableDir {
  name: string;
  path: string;
  readonly dirs: Map<string, MutableDir>;
  readonly files: FileChange[];
}

/**
 * Group changed files into a directory tree with VS Code-style compact folders:
 * a directory that contains exactly one sub-directory and no files is merged
 * with that child (`a` + `b` → `a/b`). Pure — no `vscode` dependency — so it is
 * unit-testable in isolation.
 */
export function buildFileTree(files: readonly FileChange[]): FileTree {
  const root: MutableDir = { name: '', path: '', dirs: new Map(), files: [] };

  for (const file of files) {
    const parts = file.path.split('/');
    parts.pop(); // drop the file name; remaining parts are directories
    let cursor = root;
    for (const segment of parts) {
      let next = cursor.dirs.get(segment);
      if (!next) {
        next = {
          name: segment,
          path: cursor.path ? `${cursor.path}/${segment}` : segment,
          dirs: new Map(),
          files: [],
        };
        cursor.dirs.set(segment, next);
      }
      cursor = next;
    }
    cursor.files.push(file);
  }

  return {
    dirs: [...root.dirs.values()].map(compactDir).sort(byDirName),
    files: [...root.files].sort(byFilePath),
  };
}

function compactDir(dir: MutableDir): FileTreeDir {
  let { name, path } = dir;
  let dirs = dir.dirs;
  let files = dir.files;

  // Merge single-child directory chains into one compacted node.
  while (files.length === 0 && dirs.size === 1) {
    const only = dirs.values().next().value as MutableDir;
    name = `${name}/${only.name}`;
    path = only.path;
    dirs = only.dirs;
    files = only.files;
  }

  return {
    name,
    path,
    dirs: [...dirs.values()].map(compactDir).sort(byDirName),
    files: [...files].sort(byFilePath),
  };
}

function byDirName(a: FileTreeDir, b: FileTreeDir): number {
  return a.name.localeCompare(b.name);
}

function byFilePath(a: FileChange, b: FileChange): number {
  return a.path.localeCompare(b.path);
}

/* -------------------------------------------------------------------------- */
/* Pure presentation helpers                                                  */
/* -------------------------------------------------------------------------- */

/** Single-letter status badge (git-style): A/D/M/R/B. */
export function statusLetter(status: FileStatus): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'modified':
      return 'M';
    case 'renamed':
      return 'R';
    case 'binary':
      return 'B';
  }
}

/** `"A  +12 -3"`-style description shown after a file's name. */
export function fileDescription(file: FileChange): string {
  return `${statusLetter(file.status)}  +${file.additions} -${file.deletions}`;
}

/** Basename of a path (portion after the last `/`). */
export function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** The `resourceUri` used for a file item, keyed by the decoration provider. */
export function fileResourceUri(path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: FILE_URI_SCHEME, path: `/${path}` });
}

/** Inverse of {@link fileResourceUri}. */
export function pathFromResourceUri(uri: vscode.Uri): string {
  return uri.path.replace(/^\//, '');
}

/* -------------------------------------------------------------------------- */
/* Tree node model                                                            */
/* -------------------------------------------------------------------------- */

interface HeaderNode {
  readonly kind: 'header';
}
interface DirNode {
  readonly kind: 'dir';
  readonly dir: FileTreeDir;
}
interface FileNode {
  readonly kind: 'file';
  readonly file: FileChange;
}
interface MessageNode {
  readonly kind: 'message';
  readonly message: string;
}

type TreeNode = HeaderNode | DirNode | FileNode | MessageNode;

/* -------------------------------------------------------------------------- */
/* Reviewed-state file decorations (check badge + dim)                        */
/* -------------------------------------------------------------------------- */

class ReviewedDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  readonly #onDidChange = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this.#onDidChange.event;

  constructor(private readonly getSession: SessionAccessor) {}

  fire(target?: vscode.Uri): void {
    this.#onDidChange.fire(target);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== FILE_URI_SCHEME) return undefined;
    const session = this.getSession();
    if (session?.isReviewed(pathFromResourceUri(uri))) {
      return {
        badge: '✓',
        tooltip: 'Reviewed',
        color: new vscode.ThemeColor('disabledForeground'),
      };
    }
    return undefined;
  }

  dispose(): void {
    this.#onDidChange.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/* Tree data provider                                                         */
/* -------------------------------------------------------------------------- */

class ArgusTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  readonly #onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#onDidChangeTreeData.event;

  #boundSession: PrSession | null = null;
  #sessionSubs: vscode.Disposable[] = [];
  #treeView: vscode.TreeView<TreeNode> | undefined;

  constructor(
    private readonly getSession: SessionAccessor,
    private readonly deco: ReviewedDecorationProvider,
  ) {}

  setTreeView(view: vscode.TreeView<TreeNode>): void {
    this.#treeView = view;
  }

  /** Re-bind to the current session (if it changed), rebuild, refresh badge. */
  refresh(): void {
    this.#syncBinding();
    this.#onDidChangeTreeData.fire();
    this.#updateBadge();
    this.deco.fire();
  }

  #syncBinding(): void {
    const session = this.getSession();
    if (session === this.#boundSession) return;
    this.#disposeSessionSubs();
    this.#boundSession = session;
    if (session) {
      this.#sessionSubs.push(
        session.onDidChangeReview(() => {
          this.#onDidChangeTreeData.fire();
          this.#updateBadge();
        }),
        session.onDidChangeReviewedState((path) => {
          this.#onDidChangeTreeData.fire();
          this.deco.fire(fileResourceUri(path));
          this.#updateBadge();
        }),
      );
    }
  }

  #updateBadge(): void {
    if (!this.#treeView) return;
    const session = this.getSession();
    if (!session) {
      this.#treeView.badge = undefined;
      return;
    }
    const unreviewed = session.files.filter(
      (f) => !session.isReviewed(f.path),
    ).length;
    this.#treeView.badge =
      unreviewed > 0
        ? {
            value: unreviewed,
            tooltip: `${unreviewed} file${unreviewed === 1 ? '' : 's'} left to review`,
          }
        : undefined;
  }

  /* ---- TreeDataProvider ------------------------------------------------- */

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      // Root: re-bind lazily so a freshly assigned session is picked up even
      // without an explicit refresh call.
      this.#syncBinding();
      const session = this.getSession();
      if (!session) {
        return [
          {
            kind: 'message',
            message: 'No PR loaded. Run “ARGUS: Review PR…”.',
          },
        ];
      }
      const tree = buildFileTree(session.files);
      return [
        { kind: 'header' },
        ...tree.dirs.map((dir): TreeNode => ({ kind: 'dir', dir })),
        ...tree.files.map((file): TreeNode => ({ kind: 'file', file })),
      ];
    }

    if (element.kind === 'dir') {
      return [
        ...element.dir.dirs.map((dir): TreeNode => ({ kind: 'dir', dir })),
        ...element.dir.files.map((file): TreeNode => ({ kind: 'file', file })),
      ];
    }

    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'message':
        return this.#messageItem(node);
      case 'header':
        return this.#headerItem();
      case 'dir':
        return this.#dirItem(node);
      case 'file':
        return this.#fileItem(node);
    }
  }

  #messageItem(node: MessageNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.message,
      vscode.TreeItemCollapsibleState.None,
    );
    item.contextValue = 'argusMessage';
    return item;
  }

  #headerItem(): vscode.TreeItem {
    const meta = this.getSession()?.meta;
    const item = new vscode.TreeItem(
      meta?.title ?? 'Pull request',
      vscode.TreeItemCollapsibleState.None,
    );
    if (meta) {
      item.description = `#${meta.number}`;
      item.tooltip = new vscode.MarkdownString(
        `**${meta.title}** #${meta.number}\n\n` +
          `\`${meta.baseRef}\` ← \`${meta.headRef}\` · by @${meta.author}`,
      );
    }
    item.iconPath = new vscode.ThemeIcon('git-pull-request');
    item.contextValue = 'argusHeader';
    return item;
  }

  #dirItem(node: DirNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.dir.name,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.iconPath = vscode.ThemeIcon.Folder;
    item.resourceUri = vscode.Uri.from({
      scheme: FILE_URI_SCHEME,
      path: `/${node.dir.path}`,
    });
    item.contextValue = 'argusDir';
    return item;
  }

  #fileItem(node: FileNode): vscode.TreeItem {
    const session = this.getSession();
    const { file } = node;
    const reviewed = session?.isReviewed(file.path) ?? false;

    const item = new vscode.TreeItem(
      baseName(file.path),
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = fileDescription(file);
    item.resourceUri = fileResourceUri(file.path);
    item.iconPath = statusThemeIcon(file.status);
    item.tooltip = fileTooltip(file);
    item.contextValue = reviewed ? 'argusFile.reviewed' : 'argusFile.unreviewed';
    item.command = {
      command: OPEN_DIFF_COMMAND,
      title: 'Open Diff',
      arguments: [file.path],
    };
    return item;
  }

  /* ---- Reviewed toggle command handler ---------------------------------- */

  async toggleReviewed(arg?: unknown): Promise<void> {
    const session = this.getSession();
    if (!session) return;
    const path = this.#resolvePath(arg);
    if (!path) return;
    await session.setReviewed(path, !session.isReviewed(path));
  }

  #resolvePath(arg?: unknown): string | undefined {
    if (isFileNode(arg)) return arg.file.path;
    if (typeof arg === 'string') return arg;

    const selected = this.#treeView?.selection.find(isFileNode);
    if (selected) return selected.file.path;

    // Fall back to the file open in the active argus:// diff editor.
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active && active.scheme === 'argus') {
      try {
        return parseArgusUri(active).path;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  #disposeSessionSubs(): void {
    for (const sub of this.#sessionSubs) sub.dispose();
    this.#sessionSubs = [];
  }

  dispose(): void {
    this.#disposeSessionSubs();
    this.#onDidChangeTreeData.dispose();
  }
}

function isFileNode(value: unknown): value is FileNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as TreeNode).kind === 'file'
  );
}

function statusThemeIcon(status: FileStatus): vscode.ThemeIcon {
  switch (status) {
    case 'added':
      return new vscode.ThemeIcon(
        'diff-added',
        new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
      );
    case 'deleted':
      return new vscode.ThemeIcon(
        'diff-removed',
        new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
      );
    case 'renamed':
      return new vscode.ThemeIcon(
        'diff-renamed',
        new vscode.ThemeColor('gitDecoration.renamedResourceForeground'),
      );
    case 'binary':
      return new vscode.ThemeIcon('file-binary');
    case 'modified':
      return new vscode.ThemeIcon(
        'diff-modified',
        new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      );
  }
}

function fileTooltip(file: FileChange): vscode.MarkdownString {
  const lines = [
    `\`${file.path}\``,
    '',
    `Status: **${file.status}**`,
    `Changes: +${file.additions} / -${file.deletions}`,
  ];
  if (file.oldPath && file.oldPath !== file.path) {
    lines.push('', `Renamed from \`${file.oldPath}\``);
  }
  return new vscode.MarkdownString(lines.join('\n'));
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Register the changed-files tree.
 *
 * Contract (design spec + contract 13):
 * - Provide a {@link vscode.TreeDataProvider} for view id `argus.files`, listing
 *   {@link PrSession.files} with each file's status (added/modified/deleted/
 *   renamed/binary) and ±addition/deletion counts as description/tooltip.
 * - A reviewed file shows a distinct icon/`resourceUri` context and is de-
 *   emphasised; drive it from {@link PrSession.isReviewed}.
 * - Selecting a file opens the native diff editor (base vs head) via the
 *   `argus://` content provider — fire `vscode.diff` with the two virtual URIs.
 * - Provide inline/context actions bound to `argus.toggleReviewed`.
 * - Refresh on {@link PrSession.onDidChangeReviewedState} and
 *   {@link PrSession.onDidChangeReview}; rebuild from scratch when the session
 *   accessor returns a new instance.
 * - Push all disposables onto `context.subscriptions`.
 *
 * @param context     Extension context (for subscriptions).
 * @param getSession  Lazily resolves the current {@link PrSession} or `null`.
 */
export function registerTree(
  context: vscode.ExtensionContext,
  getSession: SessionAccessor,
): void {
  const deco = new ReviewedDecorationProvider(getSession);
  const provider = new ArgusTreeProvider(getSession, deco);

  const treeView = vscode.window.createTreeView<TreeNode>(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  provider.setTreeView(treeView);

  context.subscriptions.push(
    treeView,
    provider,
    deco,
    vscode.window.registerFileDecorationProvider(deco),
    vscode.commands.registerCommand(TOGGLE_REVIEWED_COMMAND, (arg?: unknown) =>
      provider.toggleReviewed(arg),
    ),
    vscode.commands.registerCommand(TREE_REFRESH_COMMAND, () =>
      provider.refresh(),
    ),
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) provider.refresh();
    }),
  );

  provider.refresh();
}
