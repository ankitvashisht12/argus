import { describe, expect, it } from 'vitest';

import type { PrSession } from '../src/prSession';
import { buildOverviewModel } from '../src/overviewPanel';

/**
 * Uncovered-hunks indicator (v0.1.4): {@link buildOverviewModel} surfaces the
 * engine's `uncoveredHunkIds` count on the overview model's `uncoveredCount`, so
 * the Overview tab can show the honesty backstop ("N hunks not covered").
 *
 * The builder only reads session getters, so a duck-typed fake is enough — no
 * extension host required.
 */

const META = {
  owner: 'acme',
  repo: 'widgets',
  number: 42,
  title: 'A PR',
  author: 'octocat',
};

function fakeSession(
  uncoveredHunkIds: string[],
  extra: Record<string, unknown> = {},
): PrSession {
  return {
    meta: META,
    reviewError: null,
    reviewStatus: 'ready',
    reviewProgress: null,
    overview: { summary: 's', intent: 'i', critical: [], flow: [] },
    files: [],
    review: { uncoveredHunkIds },
    fileReview: () => undefined,
    isReviewed: () => false,
    ...extra,
  } as unknown as PrSession;
}

describe('buildOverviewModel uncoveredCount', () => {
  it('reports the uncovered-hunk count when the review has coverage gaps', () => {
    const model = buildOverviewModel(fakeSession(['a.ts:h1', 'a.ts:h2']));
    expect(model.state).toBe('ready');
    expect(model.uncoveredCount).toBe(2);
  });

  it('is 0 for a fully-covered review (the normal case)', () => {
    const model = buildOverviewModel(fakeSession([]));
    expect(model.state).toBe('ready');
    expect(model.uncoveredCount).toBe(0);
  });

  it('is 0 in the empty state (no session)', () => {
    const model = buildOverviewModel(null);
    expect(model.state).toBe('empty');
    expect(model.uncoveredCount).toBe(0);
  });
});

describe('buildOverviewModel progressive progress (v0.2.0)', () => {
  const PROGRESS = {
    done: 2,
    failed: 1,
    total: 4,
    running: ['src/b.ts'],
    files: [
      { path: 'src/a.ts', status: 'ready', error: null },
      { path: 'src/b.ts', status: 'running', error: null },
      { path: 'src/c.ts', status: 'error', error: 'boom' },
      { path: 'src/d.ts', status: 'pending', error: null },
    ],
  };

  it('exposes live progress + reviewing while the run is in flight (partial ready)', () => {
    const model = buildOverviewModel(
      fakeSession([], { reviewStatus: 'running', reviewProgress: PROGRESS }),
    );
    expect(model.state).toBe('ready'); // intent landed → render it
    expect(model.reviewing).toBe(true);
    expect(model.progress).toEqual(PROGRESS);
  });

  it('suppresses the uncovered-hunks line while files are still landing', () => {
    const model = buildOverviewModel(
      fakeSession(['x:h1'], { reviewStatus: 'running', reviewProgress: PROGRESS }),
    );
    expect(model.uncoveredCount).toBe(0);
  });

  it('carries progress into the loading state before the intent lands', () => {
    const model = buildOverviewModel(
      fakeSession([], {
        overview: null,
        review: null,
        reviewStatus: 'running',
        reviewProgress: PROGRESS,
      }),
    );
    expect(model.state).toBe('loading');
    expect(model.progress).toEqual(PROGRESS);
  });

  it('keeps progress at settle so failed files stay retryable from the Overview', () => {
    const model = buildOverviewModel(
      fakeSession([], { reviewStatus: 'ready', reviewProgress: PROGRESS }),
    );
    expect(model.state).toBe('ready');
    expect(model.reviewing).toBe(false);
    expect(model.progress?.failed).toBe(1);
  });
});
