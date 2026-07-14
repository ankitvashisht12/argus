/**
 * Minimal `vscode` stand-in for vitest. The extension's pure helpers only touch
 * `vscode.Uri` (construction / field access); everything else here exists so that
 * importing a surface module for its pure exports does not crash at load time.
 *
 * This is aliased to the bare `vscode` specifier in `vitest.config.ts`.
 */

export class Uri {
  private constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
    public readonly query: string,
    public readonly fragment: string,
  ) {}

  static from(components: {
    scheme?: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      components.scheme ?? '',
      components.authority ?? '',
      components.path ?? '',
      components.query ?? '',
      components.fragment ?? '',
    );
  }

  static parse(value: string): Uri {
    const u = new URL(value);
    return new Uri(
      u.protocol.replace(/:$/, ''),
      u.host,
      u.pathname,
      u.search.replace(/^\?/, ''),
      u.hash.replace(/^#/, ''),
    );
  }

  toString(): string {
    const q = this.query ? `?${this.query}` : '';
    const f = this.fragment ? `#${this.fragment}` : '';
    return `${this.scheme}://${this.authority}${this.path}${q}${f}`;
  }
}

export class EventEmitter<T> {
  event = (_listener: (e: T) => void): { dispose(): void } => ({ dispose() {} });
  fire(_data: T): void {}
  dispose(): void {}
}

export class ThemeIcon {
  constructor(
    public id: string,
    public color?: unknown,
  ) {}
  static readonly Folder = new ThemeIcon('folder');
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class MarkdownString {
  supportThemeIcons = false;
  constructor(public value = '') {}
}

export class Range {
  constructor(
    public startLine: number,
    public startChar: number,
    public endLine: number,
    public endChar: number,
  ) {}
}

export const CommentMode = { Editing: 0, Preview: 1 } as const;
export const CommentThreadCollapsibleState = { Collapsed: 0, Expanded: 1 } as const;
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
