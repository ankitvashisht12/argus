import { describe, expect, it } from 'vitest';

import type { FileChange, ReviewResult } from '@argus/engine';

import type { PrSession } from '../src/prSession';
import {
  baseName,
  buildFileTree,
  fileDescription,
  fileRowDescription,
  parentDir,
  readingPlan,
  statusLetter,
} from '../src/tree';

function file(path: string, extra: Partial<FileChange> = {}): FileChange {
  return {
    path,
    status: 'modified',
    additions: 1,
    deletions: 0,
    hunks: [],
    ...extra,
  };
}

/** Duck-typed session exposing only what {@link readingPlan} reads. */
function fakeSession(files: FileChange[], review?: ReviewResult): PrSession {
  return {
    files,
    review: review ? { review, anchored: [], uncoveredHunkIds: [] } : null,
  } as unknown as PrSession;
}

function reviewWith(files: ReviewResult['files']): ReviewResult {
  return {
    version: 1,
    summary: 's',
    intent: 'i',
    critical: [],
    flow: [],
    files,
    hunks: [],
  };
}

describe('statusLetter', () => {
  it('maps every status to its git letter', () => {
    expect(statusLetter('added')).toBe('A');
    expect(statusLetter('deleted')).toBe('D');
    expect(statusLetter('modified')).toBe('M');
    expect(statusLetter('renamed')).toBe('R');
    expect(statusLetter('binary')).toBe('B');
  });
});

describe('fileDescription', () => {
  it('renders status letter plus counts', () => {
    expect(
      fileDescription(file('a.ts', { status: 'modified', additions: 12, deletions: 3 })),
    ).toBe('M  +12 -3');
  });
});

describe('baseName', () => {
  it('returns the trailing segment', () => {
    expect(baseName('src/a/b.ts')).toBe('b.ts');
    expect(baseName('top.ts')).toBe('top.ts');
  });
});

describe('parentDir', () => {
  it('returns the directory portion, empty at the root', () => {
    expect(parentDir('src/a/b.ts')).toBe('src/a');
    expect(parentDir('top.ts')).toBe('');
  });
});

describe('fileRowDescription', () => {
  it('prefixes the parent directory before the status counts', () => {
    expect(
      fileRowDescription(file('src/auth/token.ts', { additions: 12, deletions: 3 })),
    ).toBe('src/auth  ·  M  +12 -3');
  });

  it('shows just the counts for a root-level file', () => {
    expect(fileRowDescription(file('root.ts', { additions: 1, deletions: 0 }))).toBe(
      'M  +1 -0',
    );
  });
});

describe('readingPlan', () => {
  it('uses the heuristic bucket order before a review lands', () => {
    const session = fakeSession([
      file('yarn.lock'),
      file('src/core.ts'),
      file('src/core.test.ts'),
      file('README.md'),
    ]);
    const plan = readingPlan(session);
    expect(plan.map((b) => b.label)).toEqual(['Source', 'Tests', 'Docs', 'Generated']);
    expect(plan[0].files.map((f) => f.path)).toEqual(['src/core.ts']);
  });

  it("re-sorts by the model's bucket/readingOrder once the review is present", () => {
    const files = [file('src/api.ts'), file('src/core.ts')];
    const review = reviewWith([
      { path: 'src/core.ts', role: 'r', note: 'n', bucket: 'Core logic', readingOrder: 0 },
      { path: 'src/api.ts', role: 'r', note: 'n', bucket: 'API surface', readingOrder: 1 },
    ]);
    const plan = readingPlan(fakeSession(files, review));
    expect(plan.map((b) => b.label)).toEqual(['Core logic', 'API surface']);
    expect(plan[0].files.map((f) => f.path)).toEqual(['src/core.ts']);
  });

  it('is empty when no files are present', () => {
    expect(readingPlan(fakeSession([]))).toEqual([]);
  });
});

describe('buildFileTree', () => {
  it('groups files by directory', () => {
    const tree = buildFileTree([file('src/a.ts'), file('src/b.ts'), file('root.ts')]);
    expect(tree.files.map((f) => f.path)).toEqual(['root.ts']);
    expect(tree.dirs).toHaveLength(1);
    expect(tree.dirs[0]?.name).toBe('src');
    expect(tree.dirs[0]?.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('compacts single-child directory chains', () => {
    const tree = buildFileTree([file('a/b/c/deep.ts')]);
    expect(tree.dirs).toHaveLength(1);
    expect(tree.dirs[0]?.name).toBe('a/b/c');
    expect(tree.dirs[0]?.files.map((f) => f.path)).toEqual(['a/b/c/deep.ts']);
  });

  it('stops compacting when a directory holds files or multiple children', () => {
    const tree = buildFileTree([file('a/b/x.ts'), file('a/c/y.ts')]);
    expect(tree.dirs[0]?.name).toBe('a');
    expect(tree.dirs[0]?.dirs.map((d) => d.name).sort()).toEqual(['b', 'c']);
  });
});
