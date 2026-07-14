import { describe, expect, it } from 'vitest';

import type { AnchoredHunkReview, FileChange } from '@argus/engine';

import { aiThreadRange, aiThreadUri } from '../src/comments';
import { diffUrisForFile } from '../src/contentProvider';

const meta = {
  owner: 'acme',
  repo: 'widgets',
  number: 482,
  baseSha: 'base111',
  headSha: 'head222',
};

function file(path: string, extra: Partial<FileChange> = {}): FileChange {
  return { path, status: 'modified', additions: 1, deletions: 0, hunks: [], ...extra };
}

function anchor(extra: Partial<AnchoredHunkReview>): AnchoredHunkReview {
  return {
    hunkId: 'h1',
    why: 'why',
    lookout: 'lookout',
    importance: 'normal',
    path: 'new/name.ts',
    startLine: 1,
    endLine: 2,
    side: 'new',
    ...extra,
  };
}

describe('aiThreadUri', () => {
  it('anchors an old-side note on a renamed file to the base (oldPath) document', () => {
    const renamed = file('new/name.ts', { status: 'renamed', oldPath: 'old/name.ts' });
    // Anchor carries the HEAD path (as the normalizer sets it) but side 'old'.
    const uri = aiThreadUri(meta, [renamed], anchor({ side: 'old' }));
    // Must match the base document the diff editor actually opens — oldPath, not
    // the anchor's head path — so the thread is attached to a visible document.
    expect(uri?.toString()).toBe(diffUrisForFile(meta, renamed).base.toString());
    expect(uri?.authority).toBe('base');
    expect(uri?.path).toBe('/acme/widgets/482/old/name.ts');
  });

  it('anchors a new-side note to the head document', () => {
    const renamed = file('new/name.ts', { status: 'renamed', oldPath: 'old/name.ts' });
    const uri = aiThreadUri(meta, [renamed], anchor({ side: 'new' }));
    expect(uri?.authority).toBe('head');
    expect(uri?.path).toBe('/acme/widgets/482/new/name.ts');
  });

  it('uses the same path on both sides for a non-renamed file', () => {
    const modified = file('a.ts');
    const oldSide = aiThreadUri(meta, [modified], anchor({ path: 'a.ts', side: 'old' }));
    const newSide = aiThreadUri(meta, [modified], anchor({ path: 'a.ts', side: 'new' }));
    expect(oldSide?.path).toBe('/acme/widgets/482/a.ts');
    expect(newSide?.path).toBe('/acme/widgets/482/a.ts');
    expect(oldSide?.authority).toBe('base');
    expect(newSide?.authority).toBe('head');
  });

  it('returns null when the anchor file is not in the session', () => {
    expect(aiThreadUri(meta, [], anchor({ path: 'missing.ts' }))).toBeNull();
  });
});

describe('aiThreadRange', () => {
  it('builds a single-line 0-based range from the 1-based first-changed line', () => {
    // Engine anchors to a single line: startLine === endLine (e.g. line 103).
    const range = aiThreadRange(anchor({ startLine: 103, endLine: 103 }));
    expect([range.startLine, range.startChar, range.endLine, range.endChar]).toEqual([
      102, 0, 102, 0,
    ]);
  });

  it('never spans multiple lines even if endLine drifts past startLine', () => {
    // Defensive: a multi-line range would render the thread at the hunk END in
    // VS Code. We anchor to startLine only, so start === end regardless.
    const range = aiThreadRange(anchor({ startLine: 11, endLine: 14 }));
    expect(range.startLine).toBe(range.endLine);
    expect(range.startLine).toBe(10); // 11 -> 0-based 10
  });

  it('clamps a first line (startLine 1) to row 0 without going negative', () => {
    const range = aiThreadRange(anchor({ startLine: 1, endLine: 1 }));
    expect([range.startLine, range.endLine]).toEqual([0, 0]);
  });
});
