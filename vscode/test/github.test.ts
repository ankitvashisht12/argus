import { describe, expect, it } from 'vitest';

import {
  parsePrInput,
  prUrl,
  toReviewComment,
  toReviewComments,
  toReviewSide,
} from '../src/github';

describe('parsePrInput', () => {
  it('parses a full GitHub PR URL', () => {
    expect(parsePrInput('https://github.com/acme/widgets/pull/482')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 482,
    });
  });

  it('ignores trailing path/query on a PR URL', () => {
    expect(
      parsePrInput('https://github.com/acme/widgets/pull/482/files?w=1'),
    ).toEqual({ owner: 'acme', repo: 'widgets', number: 482 });
  });

  it('parses owner/repo#number', () => {
    expect(parsePrInput('acme/widgets#12')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 12,
    });
  });

  it('parses owner/repo number and owner/repo/number', () => {
    expect(parsePrInput('acme/widgets 7')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 7,
    });
    expect(parsePrInput('acme/widgets/7')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 7,
    });
  });

  it('strips a trailing .git from the repo', () => {
    expect(parsePrInput('acme/widgets.git#3')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 3,
    });
  });

  it('returns null for junk / empty / non-positive numbers', () => {
    expect(parsePrInput('')).toBeNull();
    expect(parsePrInput('not a pr')).toBeNull();
    expect(parsePrInput('acme/widgets#0')).toBeNull();
    expect(parsePrInput('acme/widgets#-4')).toBeNull();
  });
});

describe('toReviewSide', () => {
  it('maps engine diff sides to GitHub sides', () => {
    expect(toReviewSide('old')).toBe('LEFT');
    expect(toReviewSide('new')).toBe('RIGHT');
  });
});

describe('toReviewComment', () => {
  it('maps a single-line draft', () => {
    expect(
      toReviewComment({ path: 'a.ts', line: 10, side: 'new', body: 'hi' }),
    ).toEqual({ path: 'a.ts', line: 10, side: 'RIGHT', body: 'hi' });
  });

  it('preserves a distinct multi-line range', () => {
    expect(
      toReviewComment({
        path: 'a.ts',
        line: 12,
        side: 'new',
        startLine: 10,
        startSide: 'old',
        body: 'range',
      }),
    ).toEqual({
      path: 'a.ts',
      line: 12,
      side: 'RIGHT',
      startLine: 10,
      startSide: 'LEFT',
      body: 'range',
    });
  });

  it('drops a degenerate startLine equal to line', () => {
    const c = toReviewComment({
      path: 'a.ts',
      line: 10,
      side: 'old',
      startLine: 10,
      body: 'x',
    });
    expect(c).not.toHaveProperty('startLine');
    expect(c.side).toBe('LEFT');
  });

  it('maps a list', () => {
    expect(
      toReviewComments([{ path: 'a', line: 1, side: 'new', body: 'b' }]),
    ).toHaveLength(1);
  });
});

describe('prUrl', () => {
  it('builds the canonical PR URL', () => {
    expect(prUrl({ owner: 'acme', repo: 'widgets', number: 482 })).toBe(
      'https://github.com/acme/widgets/pull/482',
    );
  });
});
