import { describe, it, expect } from 'vitest';
import type { FileChange, Hunk, ReviewResult } from '../src/types.js';
import {
  buildDigest,
  bucketFiles,
  heuristicBucket,
  firstChangedLine,
  normalizeReview,
  READING_BUCKETS,
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

/**
 * A modified file whose single hunk has SEVERAL leading context lines before the
 * first real change — the exact shape that made notes anchor above the change.
 */
const contextHeavyFile: FileChange = {
  path: 'src/deep.ts',
  status: 'modified',
  additions: 2,
  deletions: 1,
  hunks: [
    hunk({
      id: `src/deep.ts:${SHA}:h1`,
      oldStart: 100,
      oldLines: 6,
      newStart: 100,
      newLines: 7,
      patch:
        '@@ -100,6 +100,7 @@\n ctx1\n ctx2\n ctx3\n-removed\n+added1\n+added2\n ctx4\n ctx5',
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
/* firstChangedLine                                                            */
/* -------------------------------------------------------------------------- */

describe('firstChangedLine', () => {
  it('skips leading context lines to the first ADDED line on the new side', () => {
    // 3 context lines from newStart 100 -> first "+added1" is new line 103.
    expect(firstChangedLine(contextHeavyFile.hunks[0], 'new')).toBe(103);
  });

  it('skips leading context lines to the first REMOVED line on the old side', () => {
    // Same hunk on the old side: ctx1..ctx3 then "-removed" at old line 103.
    expect(firstChangedLine(contextHeavyFile.hunks[0], 'old')).toBe(103);
  });

  it('returns the added line for a pure-addition hunk (no context)', () => {
    // "@@ -0,0 +1,3 @@\n+one..." — first added line is new line 1.
    expect(firstChangedLine(addedFile.hunks[0], 'new')).toBe(1);
  });

  it('returns the first removed line for a pure-deletion hunk', () => {
    // "@@ -5,4 +4,0 @@\n-a..." — first removed line is old line 5.
    expect(firstChangedLine(deletionFile.hunks[0], 'old')).toBe(5);
  });

  it('falls back to the side start line for a pure-context hunk', () => {
    const ctxOnly = hunk({
      id: `x:${SHA}:h1`,
      oldStart: 20,
      oldLines: 2,
      newStart: 30,
      newLines: 2,
      patch: '@@ -20,2 +30,2 @@\n ctx1\n ctx2',
    });
    expect(firstChangedLine(ctxOnly, 'new')).toBe(30);
    expect(firstChangedLine(ctxOnly, 'old')).toBe(20);
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
    // Patch: "@@ -10,3 +10,5 @@\n context\n-old\n+new1\n+new2\n+new3\n context".
    // newStart 10 is a leading CONTEXT line; the first ADDED line (+new1) is new
    // line 11. The thread anchors to that single line, not the whole 10..14 span.
    expect(a.startLine).toBe(11);
    expect(a.endLine).toBe(11);
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
    // Pure deletion "@@ -5,4 +4,0 @@\n-a\n-b\n-c\n-d": first removed line is old
    // line 5, and the anchor is that single line (not the 5..8 span).
    expect(a.startLine).toBe(5);
    expect(a.endLine).toBe(5);
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
    // Patch "@@ -40,2 +42,2 @@\n-x\n+y\n context": first added line (+y) is new
    // line 42; anchored to that single line.
    expect(out.anchored[0].startLine).toBe(42);
    expect(out.anchored[0].endLine).toBe(42);
  });

  it('preserves the raw review verbatim on the result', () => {
    const digest = buildDigest(threeFileFixture);
    const raw = review([
      { hunkId: 'h1', why: 'w', lookout: 'l', importance: 'normal' },
    ]);
    const out = normalizeReview(raw, threeFileFixture, digest.aliasToHunkId);
    expect(out.review).toBe(raw);
  });

  it('resolves aliases despite surrounding whitespace and wrong case', () => {
    const digest = buildDigest(threeFileFixture);
    const raw = review([
      { hunkId: ' H1 ', why: 'w', lookout: 'l', importance: 'normal' }, // upper + spaces
      { hunkId: 'H4', why: 'w', lookout: 'l', importance: 'normal' }, // upper
    ]);
    const out = normalizeReview(raw, threeFileFixture, digest.aliasToHunkId);
    expect(out.anchored.map((a) => a.hunkId)).toEqual([
      `src/app.ts:${SHA}:h1`,
      `src/gone.ts:${SHA}:h1`,
    ]);
    // Those two are now covered; the remaining two are uncovered.
    expect(out.uncoveredHunkIds).toEqual([
      `src/app.ts:${SHA}:h2`,
      `src/new.ts:${SHA}:h1`,
    ]);
  });

  it('anchors every hunk of a realistic multi-hunk PR to its first changed line', () => {
    const files = [contextHeavyFile, modifiedFile, deletionFile];
    const digest = buildDigest(files);
    // Full coverage: one note per alias (h1 deep, h2/h3 app, h4 gone).
    const raw = review(
      digest.hunks.map((h) => ({
        hunkId: h.alias,
        why: 'w',
        lookout: 'l',
        importance: 'context' as const,
      })),
    );
    const out = normalizeReview(raw, files, digest.aliasToHunkId);
    expect(out.uncoveredHunkIds).toEqual([]);
    const byId = new Map(out.anchored.map((a) => [a.hunkId, a]));

    // Context-heavy hunk: anchored at new line 103 (past 3 context lines), single line.
    const deep = byId.get(`src/deep.ts:${SHA}:h1`)!;
    expect([deep.side, deep.startLine, deep.endLine]).toEqual(['new', 103, 103]);

    // app h1: first "+new1" is new line 11 (one context line before it).
    const app1 = byId.get(`src/app.ts:${SHA}:h1`)!;
    expect([app1.side, app1.startLine, app1.endLine]).toEqual(['new', 11, 11]);

    // Pure deletion: first "-" is old line 5, single line, old side.
    const gone = byId.get(`src/gone.ts:${SHA}:h1`)!;
    expect([gone.side, gone.startLine, gone.endLine]).toEqual(['old', 5, 5]);

    // No note spans more than one line (would render at the hunk END in VS Code).
    for (const a of out.anchored) {
      expect(a.startLine).toBe(a.endLine);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* heuristicBucket (pure fallback classification table)                        */
/* -------------------------------------------------------------------------- */

describe('heuristicBucket', () => {
  const table: Array<[string, (typeof READING_BUCKETS)[number]]> = [
    // Source (default)
    ['src/index.ts', 'Source'],
    ['engine/src/review/pipeline.ts', 'Source'],
    ['app/components/Button.tsx', 'Source'],
    ['lib/util.js', 'Source'],
    ['main.go', 'Source'],
    // Tests — by suffix and by directory
    ['src/app.test.ts', 'Tests'],
    ['src/app.spec.tsx', 'Tests'],
    ['test/helper.ts', 'Tests'],
    ['engine/test/review.test.ts', 'Tests'],
    ['src/components/__tests__/Button.tsx', 'Tests'],
    ['pkg/thing_test.go', 'Tests'],
    // Docs
    ['README.md', 'Docs'],
    ['docs/guide.mdx', 'Docs'],
    ['docs/api/overview.md', 'Docs'],
    ['LICENSE', 'Docs'],
    ['CHANGELOG.txt', 'Docs'],
    // Config & CI
    ['.github/workflows/ci.yml', 'Config & CI'],
    ['.gitignore', 'Config & CI'],
    ['.eslintrc.json', 'Config & CI'],
    ['tsconfig.json', 'Config & CI'],
    ['tsconfig.base.json', 'Config & CI'],
    ['vitest.config.ts', 'Config & CI'],
    ['eslint.config.mjs', 'Config & CI'],
    ['package.json', 'Config & CI'],
    ['Dockerfile', 'Config & CI'],
    ['Makefile', 'Config & CI'],
    ['config/settings.yaml', 'Config & CI'],
    ['.prettierrc', 'Config & CI'],
    // Generated / lockfiles — win over their config-shaped extensions
    ['package-lock.json', 'Generated'],
    ['yarn.lock', 'Generated'],
    ['pnpm-lock.yaml', 'Generated'],
    ['go.sum', 'Generated'],
    ['dist/index.js', 'Generated'],
    ['build/out.css', 'Generated'],
    ['coverage/lcov.info', 'Generated'],
    ['node_modules/dep/index.js', 'Generated'],
    ['src/schema.generated.ts', 'Generated'],
    ['assets/app.min.js', 'Generated'],
    ['src/__snapshots__/x.ts.snap', 'Generated'],
  ];

  it.each(table)('classifies %s as %s', (path, expected) => {
    expect(heuristicBucket(path)).toBe(expected);
  });

  it('only ever emits canonical bucket labels', () => {
    for (const [path] of table) {
      expect(READING_BUCKETS).toContain(heuristicBucket(path));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* bucketFiles (heuristic fallback ordering + review-driven ordering)          */
/* -------------------------------------------------------------------------- */

function fc(path: string): FileChange {
  return { path, status: 'modified', additions: 1, deletions: 0, hunks: [] };
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

describe('bucketFiles — heuristic fallback (no review)', () => {
  it('orders buckets source > tests > docs > config/CI > generated, alpha within', () => {
    const files = [
      fc('yarn.lock'),
      fc('README.md'),
      fc('src/b.ts'),
      fc('src/a.ts'),
      fc('package.json'),
      fc('src/a.test.ts'),
      fc('docs/guide.md'),
    ];
    const buckets = bucketFiles(files);
    expect(buckets.map((b) => b.label)).toEqual([
      'Source',
      'Tests',
      'Docs',
      'Config & CI',
      'Generated',
    ]);
    // Alphabetical within the Source bucket.
    expect(buckets[0].files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    // Docs holds both README and the docs/ file, alphabetical (localeCompare:
    // "docs/…" sorts before "README.md").
    expect(buckets[2].files.map((f) => f.path)).toEqual(['docs/guide.md', 'README.md']);
  });

  it('drops empty buckets (only non-empty groups are returned)', () => {
    const buckets = bucketFiles([fc('src/a.ts'), fc('src/b.ts')]);
    expect(buckets.map((b) => b.label)).toEqual(['Source']);
  });

  it('treats an empty file list as no buckets', () => {
    expect(bucketFiles([])).toEqual([]);
  });

  it('uses heuristic order when a review carries no reading guidance', () => {
    const files = [fc('config.yml'), fc('src/a.ts')];
    const review = reviewWith([
      { path: 'src/a.ts', role: 'r', note: 'n' }, // no bucket / readingOrder
      { path: 'config.yml', role: 'r', note: 'n' },
    ]);
    const buckets = bucketFiles(files, review);
    expect(buckets.map((b) => b.label)).toEqual(['Source', 'Config & CI']);
  });
});

describe('bucketFiles — review-driven ordering', () => {
  it("groups by the model's bucket labels and orders by readingOrder", () => {
    const files = [
      fc('src/api.ts'),
      fc('src/core.ts'),
      fc('src/api.test.ts'),
    ];
    const review = reviewWith([
      { path: 'src/core.ts', role: 'r', note: 'n', bucket: 'Core logic', readingOrder: 0 },
      { path: 'src/api.ts', role: 'r', note: 'n', bucket: 'API surface', readingOrder: 1 },
      { path: 'src/api.test.ts', role: 'r', note: 'n', bucket: 'Tests', readingOrder: 2 },
    ]);
    const buckets = bucketFiles(files, review);
    // Buckets ordered by their earliest readingOrder.
    expect(buckets.map((b) => b.label)).toEqual(['Core logic', 'API surface', 'Tests']);
    expect(buckets[0].files.map((f) => f.path)).toEqual(['src/core.ts']);
  });

  it('orders files within a bucket by readingOrder, then path', () => {
    const files = [fc('src/z.ts'), fc('src/a.ts'), fc('src/m.ts')];
    const review = reviewWith([
      { path: 'src/z.ts', role: 'r', note: 'n', bucket: 'Core', readingOrder: 0 },
      { path: 'src/a.ts', role: 'r', note: 'n', bucket: 'Core', readingOrder: 5 },
      // src/m.ts left unranked → falls back, sorts after ranked, alpha.
      { path: 'src/m.ts', role: 'r', note: 'n', bucket: 'Core' },
    ]);
    const buckets = bucketFiles(files, review);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].files.map((f) => f.path)).toEqual(['src/z.ts', 'src/a.ts', 'src/m.ts']);
  });

  it('is defensive with bogus paths and missing files (schema round-trip)', () => {
    // The review references a path that is NOT among the actual changed files
    // (bogus / stale), gives one real file guidance, and forgets another file.
    const files = [fc('src/core.ts'), fc('src/forgotten.ts'), fc('package-lock.json')];
    const review = reviewWith([
      { path: 'src/core.ts', role: 'r', note: 'n', bucket: 'Core', readingOrder: 0 },
      { path: 'does/not/exist.ts', role: 'r', note: 'n', bucket: 'Ghost', readingOrder: 1 },
      // src/forgotten.ts and package-lock.json get no entry → heuristic fallback.
    ]);
    const buckets = bucketFiles(files, review);
    const labels = buckets.map((b) => b.label);
    // The bogus path never creates a phantom row/bucket.
    expect(labels).not.toContain('Ghost');
    const all = buckets.flatMap((b) => b.files.map((f) => f.path));
    expect(all.sort()).toEqual(['package-lock.json', 'src/core.ts', 'src/forgotten.ts']);
    // The ranked "Core" bucket comes first; fallback buckets follow.
    expect(labels[0]).toBe('Core');
    // Forgotten source lands in its heuristic bucket, lockfile in Generated.
    const forgottenBucket = buckets.find((b) => b.files.some((f) => f.path === 'src/forgotten.ts'));
    expect(forgottenBucket?.label).toBe('Source');
    const lockBucket = buckets.find((b) =>
      b.files.some((f) => f.path === 'package-lock.json'),
    );
    expect(lockBucket?.label).toBe('Generated');
  });

  it('falls back to a heuristic bucket when the model gives a blank label', () => {
    const files = [fc('src/a.ts')];
    const review = reviewWith([
      { path: 'src/a.ts', role: 'r', note: 'n', bucket: '   ', readingOrder: 0 },
    ]);
    const buckets = bucketFiles(files, review);
    expect(buckets.map((b) => b.label)).toEqual(['Source']);
  });
});
