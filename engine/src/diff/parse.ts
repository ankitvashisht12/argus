/**
 * Unified-diff parser: turns raw `git`/`gh` diff text into {@link FileChange}s
 * with stable per-file {@link Hunk} IDs.
 *
 * Pure Node/stdlib. Handles added / deleted / modified / renamed / binary
 * files, mode-change-only entries, omitted hunk counts, and no-newline
 * markers. Hunk IDs are `"<path>:<headSha>:h<n>"` (1-based within a file).
 *
 * @module
 */

import type { FileChange, FileStatus, Hunk } from '../types.js';

/** Strip a leading `a/` or `b/` (or `i/`, `w/`, `c/`, `o/`) diff prefix. */
function stripPrefix(raw: string): string {
  // git uses a/ and b/ by default; also tolerate other 1-char prefixes.
  const m = /^[abciwo]\/(.*)$/.exec(raw);
  return m ? (m[1] ?? raw) : raw;
}

/** Parse the `--- ` or `+++ ` file line into a path (or undefined for /dev/null). */
function parseFileLine(line: string): string | undefined {
  // e.g. "--- a/src/foo.ts" or "+++ /dev/null" or with trailing tab-quoted name.
  let rest = line.slice(4);
  // git may quote paths containing special chars: "\"a/with space\"".
  if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) {
    rest = unquotePath(rest);
  } else {
    // strip a trailing timestamp/tab that some `git diff` variants append.
    const tab = rest.indexOf('\t');
    if (tab !== -1) rest = rest.slice(0, tab);
  }
  if (rest === '/dev/null') return undefined;
  return stripPrefix(rest);
}

/** Decode a git C-quoted path like `"a/with\tspace"`. */
function unquotePath(quoted: string): string {
  const inner = quoted.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[++i]!;
      switch (next) {
        case 't': out += '\t'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        default: out += next; break;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/** Parse the two paths out of a `diff --git a/x b/y` header line. */
function parseGitHeaderPaths(line: string): { old?: string; new?: string } {
  const rest = line.slice('diff --git '.length);
  // Quoted form: "a/x" "b/y"
  if (rest.startsWith('"')) {
    const parts = matchQuotedPair(rest);
    if (parts) {
      return { old: stripPrefix(parts[0]), new: stripPrefix(parts[1]) };
    }
  }
  // Unquoted: split on the midpoint " b/" is ambiguous for paths with spaces;
  // the unambiguous ---/+++ or rename lines override this. For the common
  // (no-space) case, split on whitespace.
  const tokens = rest.split(' ');
  if (tokens.length === 2) {
    return { old: stripPrefix(tokens[0]!), new: stripPrefix(tokens[1]!) };
  }
  // Fallback: assume the two halves are equal length (rename would be caught
  // by explicit rename lines, so equal-path is the realistic remaining case).
  const half = Math.floor(rest.length / 2);
  if (rest[half] === ' ') {
    return { old: stripPrefix(rest.slice(0, half)), new: stripPrefix(rest.slice(half + 1)) };
  }
  return {};
}

/** Match a `"a/x" "b/y"` quoted path pair. */
function matchQuotedPair(rest: string): [string, string] | undefined {
  // First quoted token.
  let i = 1;
  let first = '';
  while (i < rest.length && rest[i] !== '"') {
    if (rest[i] === '\\') { first += rest[i]! + (rest[i + 1] ?? ''); i += 2; continue; }
    first += rest[i++]!;
  }
  i++; // closing quote
  while (i < rest.length && rest[i] === ' ') i++;
  if (rest[i] !== '"') return undefined;
  i++;
  let second = '';
  while (i < rest.length && rest[i] !== '"') {
    if (rest[i] === '\\') { second += rest[i]! + (rest[i + 1] ?? ''); i += 2; continue; }
    second += rest[i++]!;
  }
  return [unquotePath('"' + first + '"'), unquotePath('"' + second + '"')];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface FileBlock {
  headerLine: string;
  lines: string[];
}

/** Split the whole diff into per-file blocks starting at each `diff --git`. */
function splitFileBlocks(diffText: string): FileBlock[] {
  const lines = diffText.split('\n');
  const blocks: FileBlock[] = [];
  let current: FileBlock | undefined;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = { headerLine: line, lines: [] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
    // lines before the first `diff --git` (e.g. commit metadata) are ignored.
  }
  return blocks;
}

/**
 * Parse a unified diff into per-file change records with parsed hunks.
 *
 * @param diffText Raw unified diff (e.g. output of `gh pr diff`).
 * @param headSha  Head commit SHA, embedded into each hunk id.
 * @returns One {@link FileChange} per file in the diff, in diff order.
 */
export function parseUnifiedDiff(diffText: string, headSha: string): FileChange[] {
  if (!diffText || diffText.trim() === '') return [];

  const files: FileChange[] = [];

  for (const block of splitFileBlocks(diffText)) {
    const headerPaths = parseGitHeaderPaths(block.headerLine);

    let status: FileStatus = 'modified';
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let minusPath: string | undefined;
    let plusPath: string | undefined;
    let sawMinus = false;
    let sawPlus = false;
    let isBinary = false;

    const hunks: Hunk[] = [];
    let additions = 0;
    let deletions = 0;

    let i = 0;
    const L = block.lines;

    // --- Metadata scan until first hunk header ---
    for (; i < L.length; i++) {
      const line = L[i]!;
      if (HUNK_HEADER.test(line)) break;

      if (line.startsWith('new file mode')) {
        status = 'added';
      } else if (line.startsWith('deleted file mode')) {
        status = 'deleted';
      } else if (line.startsWith('rename from ')) {
        renameFrom = maybeUnquote(line.slice('rename from '.length));
        status = 'renamed';
      } else if (line.startsWith('rename to ')) {
        renameTo = maybeUnquote(line.slice('rename to '.length));
        status = 'renamed';
      } else if (line.startsWith('copy from ')) {
        renameFrom = maybeUnquote(line.slice('copy from '.length));
        status = 'renamed';
      } else if (line.startsWith('copy to ')) {
        renameTo = maybeUnquote(line.slice('copy to '.length));
        status = 'renamed';
      } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        isBinary = true;
      } else if (line.startsWith('--- ')) {
        minusPath = parseFileLine(line);
        sawMinus = true;
      } else if (line.startsWith('+++ ')) {
        plusPath = parseFileLine(line);
        sawPlus = true;
      }
    }

    if (isBinary) {
      status = 'binary';
    }

    // --- Hunk bodies ---
    let hunkOrdinal = 0;
    while (i < L.length) {
      const header = L[i]!;
      const m = HUNK_HEADER.exec(header);
      if (!m) {
        i++;
        continue;
      }
      const oldStart = Number(m[1]);
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);

      const patchLines: string[] = [header];
      i++;
      for (; i < L.length; i++) {
        const line = L[i]!;
        if (HUNK_HEADER.test(line)) break;
        // A following file's header cannot appear here (blocks are pre-split),
        // so everything until the next @@ belongs to this hunk body.
        patchLines.push(line);
        if (line.startsWith('+')) additions++;
        else if (line.startsWith('-')) deletions++;
        // context (' '), no-newline ('\ ') and blank lines contribute nothing.
      }

      hunkOrdinal++;
      hunks.push({
        id: `${placeholderPath()}:${headSha}:h${hunkOrdinal}`,
        oldStart,
        oldLines,
        newStart,
        newLines,
        patch: patchLines.join('\n'),
      });
    }

    // --- Resolve the canonical path ---
    // Precedence: explicit rename lines, then ---/+++ (unambiguous), then the
    // `diff --git` header. For added files use the new side; for deleted, old.
    let path: string;
    let oldPath: string | undefined;

    if (status === 'renamed') {
      oldPath = renameFrom ?? minusPath ?? headerPaths.old;
      path = renameTo ?? plusPath ?? headerPaths.new ?? oldPath ?? '';
    } else if (status === 'added') {
      path = (sawPlus ? plusPath : undefined) ?? headerPaths.new ?? headerPaths.old ?? '';
      oldPath = undefined;
    } else if (status === 'deleted') {
      path = (sawMinus ? minusPath : undefined) ?? headerPaths.old ?? headerPaths.new ?? '';
      oldPath = undefined;
    } else {
      // modified / binary / mode-change-only
      path =
        plusPath ??
        minusPath ??
        headerPaths.new ??
        headerPaths.old ??
        '';
    }

    // Now that the path is known, rewrite hunk IDs (they were built with a
    // placeholder because the path resolves after the hunk scan).
    const finalHunks: Hunk[] = hunks.map((h, idx) => ({
      ...h,
      id: `${path}:${headSha}:h${idx + 1}`,
    }));

    files.push({
      path,
      ...(oldPath !== undefined ? { oldPath } : {}),
      status,
      additions,
      deletions,
      hunks: finalHunks,
    });
  }

  return files;
}

/** Placeholder used while building hunks before the file path is resolved. */
function placeholderPath(): string {
  return '\0';
}

/** Unquote a git path token only if it is C-quoted. */
function maybeUnquote(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return unquotePath(t);
  return t;
}
