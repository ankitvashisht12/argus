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

function fakeSession(uncoveredHunkIds: string[]): PrSession {
  return {
    meta: META,
    reviewError: null,
    overview: { summary: 's', intent: 'i', critical: [], flow: [] },
    files: [],
    review: { uncoveredHunkIds },
    fileReview: () => undefined,
    isReviewed: () => false,
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
