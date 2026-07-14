import { describe, expect, it } from 'vitest';

import type { FileChange } from '@argus/engine';

import { buildDetails } from '../src/details';
import type { PrSession } from '../src/prSession';

/**
 * Minimal duck-typed stand-in for the fields {@link buildDetails} reads. Cast to
 * `PrSession` so the pure builder can be exercised without the extension host.
 */
function fakeSession(overrides: {
  files?: FileChange[];
  reviewError?: string | null;
  overviewSummary?: string;
  reviews?: Record<string, { role: string; note: string }>;
  reviewed?: Set<string>;
}): PrSession {
  const reviews = overrides.reviews ?? {};
  return {
    meta: {
      title: 'Add token refresh',
      number: 482,
      owner: 'acme',
      repo: 'widgets',
      author: 'octocat',
    },
    files: overrides.files ?? [],
    reviewError: overrides.reviewError ?? null,
    overview: overrides.overviewSummary
      ? { summary: overrides.overviewSummary }
      : undefined,
    fileReview: (path: string) => reviews[path],
    isReviewed: (path: string) => overrides.reviewed?.has(path) ?? false,
  } as unknown as PrSession;
}

function file(path: string, hunks = 0): FileChange {
  return {
    path,
    status: 'modified',
    additions: 1,
    deletions: 0,
    hunks: Array.from({ length: hunks }, () => ({})) as FileChange['hunks'],
  };
}

describe('buildDetails', () => {
  it('returns the empty state when no session is loaded', () => {
    expect(buildDetails(null, undefined)).toEqual({ kind: 'empty' });
    expect(buildDetails(null, 'a.ts')).toEqual({ kind: 'empty' });
  });

  it('renders the PR summary when no file is focused', () => {
    const session = fakeSession({ overviewSummary: 'Refreshes tokens.' });
    expect(buildDetails(session, undefined)).toEqual({
      kind: 'pr',
      title: 'Add token refresh',
      subtitle: '#482 · acme/widgets · @octocat',
      summary: 'Refreshes tokens.',
    });
  });

  it('falls back to a generating message with no overview and no error', () => {
    const session = fakeSession({});
    expect(buildDetails(session, undefined)).toMatchObject({
      kind: 'pr',
      summary: 'Generating review…',
    });
  });

  it('surfaces the review error in the PR summary when present', () => {
    const session = fakeSession({ reviewError: 'claude not found' });
    expect(buildDetails(session, undefined)).toMatchObject({
      kind: 'pr',
      summary: 'AI review unavailable — open a changed file to see its diff.',
    });
  });

  it('renders a focused file with its AI role/note and hunk count', () => {
    const session = fakeSession({
      files: [file('src/auth.ts', 3)],
      reviews: { 'src/auth.ts': { role: 'auth', note: 'Watch the expiry math.' } },
      reviewed: new Set(['src/auth.ts']),
    });
    expect(buildDetails(session, 'src/auth.ts')).toEqual({
      kind: 'file',
      path: 'src/auth.ts',
      role: 'auth',
      note: 'Watch the expiry math.',
      hunkCount: 3,
      reviewed: true,
    });
  });

  it('uses the "AI review unavailable" note for a file when the review errored', () => {
    const session = fakeSession({ files: [file('a.ts', 1)], reviewError: 'boom' });
    expect(buildDetails(session, 'a.ts')).toMatchObject({
      kind: 'file',
      role: '',
      note: 'AI review unavailable for this PR.',
      hunkCount: 1,
      reviewed: false,
    });
  });

  it('uses the "no AI note" fallback for a file with no review and no error', () => {
    const session = fakeSession({ files: [file('a.ts', 2)] });
    expect(buildDetails(session, 'a.ts')).toMatchObject({
      kind: 'file',
      note: 'No AI note for this file.',
      hunkCount: 2,
    });
  });
});
