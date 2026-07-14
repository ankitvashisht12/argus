import { describe, expect, it } from 'vitest';

import type { FileChange } from '@argus/engine';

import {
  baseName,
  buildFileTree,
  fileDescription,
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
