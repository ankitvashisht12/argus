import { describe, it, expect } from 'vitest';
import type { FileChange, Hunk, ReviewResult } from '../src/types.js';
import {
  buildDigest,
  buildReviewPrompt,
  normalizeReview,
  reviewSchema,
  DEFAULT_DIGEST_BUDGET,
  LARGE_DIGEST_BUDGET,
} from '../src/review/pipeline.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const SHA = 'abc123';

function hunk(partial: Partial<Hunk> & { id: string }): Hunk {
  return {
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    patch: '@@ -1 +1 @@\n-a\n+b',
    ...partial,
  };
}

/** A modified file with two hunks. */
const modifiedFile: FileChange = {
  path: 'src/app.ts',
  status: 'modified',
  additions: 4,
  deletions: 2,
  hunks: [
    hunk({
      id: `src/app.ts:${SHA}:h1`,
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 5,
      patch: '@@ -10,3 +10,5 @@\n context\n-old\n+new1\n+new2\n+new3\n context',
    }),
    hunk({
      id: `src/app.ts:${SHA}:h2`,
      oldStart: 40,
      oldLines: 2,
      newStart: 42,
      newLines: 2,
      patch: '@@ -40,2 +42,2 @@\n-x\n+y\n context',
    }),
  ],
};

/** An added file with one hunk. */
const addedFile: FileChange = {
  path: 'src/new.ts',
  status: 'added',
  additions: 3,
  deletions: 0,
  hunks: [
    hunk({
      id: `src/new.ts:${SHA}:h1`,
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 3,
      patch: '@@ -0,0 +1,3 @@\n+one\n+two\n+three',
    }),
  ],
};

/** A pure-deletion hunk (whole region removed). */
const deletionFile: FileChange = {
  path: 'src/gone.ts',
  status: 'deleted',
  additions: 0,
  deletions: 4,
  hunks: [
    hunk({
      id: `src/gone.ts:${SHA}:h1`,
      oldStart: 5,
      oldLines: 4,
      newStart: 4,
      newLines: 0,
      patch: '@@ -5,4 +4,0 @@\n-a\n-b\n-c\n-d',
    }),
  ],
};

const threeFileFixture: FileChange[] = [modifiedFile, addedFile, deletionFile];

/* -------------------------------------------------------------------------- */
/* buildDigest                                                                 */
/* -------------------------------------------------------------------------- */

describe('buildDigest', () => {
  it('assigns globally-sequential aliases across files and round-trips to stable ids', () => {
    const digest = buildDigest(threeFileFixture);
    expect(digest.hunks.map((h) => h.alias)).toEqual(['h1', 'h2', 'h3', 'h4']);
    expect(digest.aliasToHunkId).toEqual({
      h1: `src/app.ts:${SHA}:h1`,
      h2: `src/app.ts:${SHA}:h2`,
      h3: `src/new.ts:${SHA}:h1`,
      h4: `src/gone.ts:${SHA}:h1`,
    });
    // Alias carries the owning file path.
    expect(digest.hunks[2].path).toBe('src/new.ts');
    expect(digest.hunks[3].path).toBe('src/gone.ts');
  });

  it('reports no truncation and a real totalChars when everything fits', () => {
    const digest = buildDigest(threeFileFixture);
    expect(digest.truncated).toBe(false);
    expect(digest.truncatedHunks).toEqual([]);
    const expectedChars = threeFileFixture
      .flatMap((f) => f.hunks)
      .reduce((sum, h) => sum + h.patch.length, 0);
    expect(digest.totalChars).toBe(expectedChars);
  });

  it('enforces the per-hunk budget and records which hunks were truncated', () => {
    const digest = buildDigest(threeFileFixture, { perHunk: 12, total: 1_000 });
    for (const h of digest.hunks) {
      expect(h.excerpt.length).toBeLessThanOrEqual(12);
    }
    // Every fixture patch is longer than 12 chars, so all are truncated.
    expect(digest.truncated).toBe(true);
    expect(digest.truncatedHunks).toEqual(['h1', 'h2', 'h3', 'h4']);
    // Truncated excerpts end with the ellipsis sentinel.
    expect(digest.hunks[0].excerpt.endsWith('…')).toBe(true);
  });

  it('enforces the total budget: excerpts shrink to zero once it is exhausted', () => {
    // total budget of 5 chars — first hunk consumes it, rest get nothing.
    const digest = buildDigest(threeFileFixture, { perHunk: 2_500, total: 5 });
    expect(digest.hunks[0].excerpt.length).toBe(5);
    expect(digest.hunks[1].excerpt).toBe('');
    expect(digest.hunks[1].truncated).toBe(true);
    expect(digest.totalChars).toBe(5);
    expect(digest.truncated).toBe(true);
    // All four are marked truncated (starved of budget counts as truncated).
    expect(digest.truncatedHunks).toEqual(['h1', 'h2', 'h3', 'h4']);
  });

  it('picks default budgets by file count', () => {
    const small = buildDigest(threeFileFixture);
    // Small PR: nothing truncated under the generous default budget.
    expect(small.truncated).toBe(false);

    // Build a >32-file PR whose hunks exceed the large per-hunk budget.
    const bigPatch = 'x'.repeat(LARGE_DIGEST_BUDGET.perHunk + 50);
    const manyFiles: FileChange[] = Array.from({ length: 40 }, (_, i) => ({
      path: `f${i}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 0,
      hunks: [hunk({ id: `f${i}.ts:${SHA}:h1`, patch: bigPatch })],
    }));
    const large = buildDigest(manyFiles);
    // Under the large budget the first hunk is clamped to perHunk.
    expect(large.hunks[0].excerpt.length).toBe(LARGE_DIGEST_BUDGET.perHunk);
    expect(large.truncated).toBe(true);
    // Sanity: the same file set would NOT truncate its first hunk under default.
    const asDefault = buildDigest(manyFiles, DEFAULT_DIGEST_BUDGET);
    expect(asDefault.hunks[0].excerpt.length).toBe(bigPatch.length);
  });

  it('handles a file with no hunks (binary) without allocating an alias', () => {
    const binary: FileChange = {
      path: 'img.png',
      status: 'binary',
      additions: 0,
      deletions: 0,
      hunks: [],
    };
    const digest = buildDigest([binary, addedFile]);
    expect(digest.hunks.map((h) => h.alias)).toEqual(['h1']);
    expect(digest.aliasToHunkId).toEqual({ h1: `src/new.ts:${SHA}:h1` });
  });
});

/* -------------------------------------------------------------------------- */
/* buildReviewPrompt                                                           */
/* -------------------------------------------------------------------------- */

describe('buildReviewPrompt', () => {
  const meta = {
    owner: 'o',
    repo: 'r',
    number: 7,
    title: 'Add retry logic',
    body: 'Retries failed requests up to 3 times.',
    baseSha: 'base',
    headSha: SHA,
    baseRef: 'main',
    headRef: 'feat',
    author: 'dev',
  };

  it('embeds intent sources, aliases, and instructs alias-only JSON output', () => {
    const digest = buildDigest(threeFileFixture);
    const prompt = buildReviewPrompt(meta, digest);
    expect(prompt).toContain('Add retry logic');
    expect(prompt).toContain('Retries failed requests up to 3 times.');
    // Every alias appears in the prompt.
    for (const h of digest.hunks) {
      expect(prompt).toContain(h.alias);
    }
    expect(prompt.toLowerCase()).toContain('json only');
    expect(prompt).toContain('Never use line numbers');
  });

  it('surfaces truncation in the prompt when the digest was clamped', () => {
    const digest = buildDigest(threeFileFixture, { perHunk: 10, total: 1_000 });
    const prompt = buildReviewPrompt(meta, digest);
    expect(prompt).toContain('truncated');
    expect(prompt).toContain('[truncated]');
  });

  it('tolerates an empty PR body', () => {
    const digest = buildDigest(threeFileFixture);
    const prompt = buildReviewPrompt({ ...meta, body: '   ' }, digest);
    expect(prompt).toContain('(no description provided)');
  });
});

/* -------------------------------------------------------------------------- */
/* reviewSchema                                                                 */
/* -------------------------------------------------------------------------- */

describe('reviewSchema', () => {
  it('forces the ReviewResult shape and pins version to 1', () => {
    const props = (reviewSchema as any).properties;
    expect((reviewSchema as any).required).toEqual([
      'version',
      'summary',
      'intent',
      'critical',
      'flow',
      'files',
      'hunks',
    ]);
    expect(props.version).toEqual({ const: 1 });
    expect((reviewSchema as any).additionalProperties).toBe(false);
    const hunkItem = props.hunks.items;
    expect(hunkItem.required).toEqual(['hunkId', 'why', 'lookout', 'importance']);
    expect(hunkItem.properties.importance.enum).toEqual([
      'critical',
      'normal',
      'context',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* normalizeReview                                                             */
/* -------------------------------------------------------------------------- */

function review(hunks: ReviewResult['hunks']): ReviewResult {
  return {
    version: 1,
    summary: 's',
    intent: 'i',
    critical: [],
    flow: [],
    files: [],
    hunks,
  };
}

describe('normalizeReview', () => {
  it('resolves aliases to stable ids and computes new-side anchors', () => {
    const digest = buildDigest(threeFileFixture);
    const raw = review([
      { hunkId: 'h1', why: 'w', lookout: 'l', importance: 'critical' },
    ]);
    const out = normalizeReview(raw, threeFileFixture, digest.aliasToHunkId);
    expect(out.anchored).toHaveLength(1);
    const a = out.anchored[0];
    expect(a.hunkId).toBe(`src/app.ts:${SHA}:h1`);
    expect(a.path).toBe('src/app.ts');
    expect(a.side).toBe('new');
    // newStart 10, newLines 5 -> 10..14
    expect(a.startLine).toBe(10);
    expect(a.endLine).toBe(14);
    expect(a.importance).toBe('critical');
  });

  it('anchors a pure-deletion hunk on the old side', () => {
    const digest = buildDigest(threeFileFixture);
    const raw = review([
      { hunkId: 'h4', why: 'w', lookout: 'l', importance: 'normal' },
    ]);
    const out = normalizeReview(raw, threeFileFixture, digest.aliasToHunkId);
    const a = out.anchored[0];
    expect(a.hunkId).toBe(`src/gone.ts:${SHA}:h1`);
    expect(a.side).toBe('old');
    // oldStart 5, oldLines 4 -> 5..8
    expect(a.startLine).toBe(5);
    expect(a.endLine).toBe(8);
  });

  it('drops unknown aliases', () => {
    const digest = buildDigest(threeFileFixture);
    const raw = review([
      { hunkId: 'h1', why: 'w', lookout: 'l', importance: 'normal' },
      { hunkId: 'h99', why: 'w', lookout: 'l', importance: 'normal' },
      { hunkId: '', why: 'w', lookout: 'l', importance: 'normal' },
    ]);
    const out = normalizeReview(raw, threeFileFixture, digest.aliasToHunkId);
    expect(out.anchored.map((a) => a.hunkId)).toEqual([`src/app.ts:${SHA}:h1`]);
  });

  it('dedupes repeated references, keeping the first', () => {
    const digest = buildDigest(threeFileFixture);
    const raw = review([
      { hunkId: 'h2', why: 'first', lookout: 'l', importance: 'normal' },
      { hunkId: 'h2', why: 'second', lookout: 'l', importance: 'critical' },
    ]);
    const out = normalizeReview(raw, threeFileFixture, digest.aliasToHunkId);
    expect(out.anchored).toHaveLength(1);
    expect(out.anchored[0].why).toBe('first');
    expect(out.anchored[0].importance).toBe('normal');
  });

  it('sweeps unreferenced hunks into uncoveredHunkIds in diff order', () => {
    const digest = buildDigest(threeFileFixture);
    const raw = review([
      { hunkId: 'h3', why: 'w', lookout: 'l', importance: 'normal' },
    ]);
    const out = normalizeReview(raw, threeFileFixture, digest.aliasToHunkId);
    expect(out.uncoveredHunkIds).toEqual([
      `src/app.ts:${SHA}:h1`,
      `src/app.ts:${SHA}:h2`,
      `src/gone.ts:${SHA}:h1`,
    ]);
  });

  it('reports every hunk uncovered when the review references none', () => {
    const digest = buildDigest(threeFileFixture);
    const out = normalizeReview(review([]), threeFileFixture, digest.aliasToHunkId);
    expect(out.anchored).toEqual([]);
    expect(out.uncoveredHunkIds).toHaveLength(4);
  });

  it('treats hunkIds as stable ids when no alias map is given', () => {
    const raw = review([
      {
        hunkId: `src/app.ts:${SHA}:h2`,
        why: 'w',
        lookout: 'l',
        importance: 'normal',
      },
    ]);
    const out = normalizeReview(raw, threeFileFixture);
    expect(out.anchored).toHaveLength(1);
    expect(out.anchored[0].hunkId).toBe(`src/app.ts:${SHA}:h2`);
    expect(out.anchored[0].side).toBe('new');
    // newStart 42, newLines 2 -> 42..43
    expect(out.anchored[0].startLine).toBe(42);
    expect(out.anchored[0].endLine).toBe(43);
  });

  it('preserves the raw review verbatim on the result', () => {
    const digest = buildDigest(threeFileFixture);
    const raw = review([
      { hunkId: 'h1', why: 'w', lookout: 'l', importance: 'normal' },
    ]);
    const out = normalizeReview(raw, threeFileFixture, digest.aliasToHunkId);
    expect(out.review).toBe(raw);
  });
});
