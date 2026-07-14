import { describe, expect, it } from 'vitest';

import {
  argusUriForSide,
  buildArgusUri,
  diffUrisForFile,
  errorBanner,
  parseArgusUri,
  placeholderBanner,
  sessionMatchesUri,
} from '../src/contentProvider';
import { parseArgusUri as parseSidebarUri } from '../src/sidebar';

const meta = {
  owner: 'acme',
  repo: 'widgets',
  number: 482,
  baseSha: 'base111',
  headSha: 'head222',
};

describe('buildArgusUri / parseArgusUri round-trip', () => {
  it('round-trips a nested path', () => {
    const uri = buildArgusUri({
      side: 'head',
      owner: 'acme',
      repo: 'widgets',
      number: 482,
      path: 'src/auth/token.ts',
      sha: 'head222',
    });
    expect(uri.authority).toBe('head');
    expect(uri.path).toBe('/acme/widgets/482/src/auth/token.ts');

    const parts = parseArgusUri(uri);
    expect(parts).toEqual({
      side: 'head',
      owner: 'acme',
      repo: 'widgets',
      number: 482,
      path: 'src/auth/token.ts',
      sha: 'head222',
    });
  });

  it('encodes path segments with special characters', () => {
    const uri = buildArgusUri({
      side: 'base',
      owner: 'a b',
      repo: 'r#1',
      number: 3,
      path: 'dir/a file.ts',
      sha: 'x',
    });
    // Reserved characters must survive the round-trip.
    expect(parseArgusUri(uri)).toMatchObject({
      owner: 'a b',
      repo: 'r#1',
      path: 'dir/a file.ts',
    });
  });

  it('rejects non-argus / short URIs', () => {
    expect(() =>
      parseArgusUri({ authority: 'nope', path: '/a/b/c/d', query: '' } as never),
    ).toThrow();
  });
});

describe('diffUrisForFile', () => {
  it('pins each side to its SHA and uses oldPath for renames on base', () => {
    const { base, head } = diffUrisForFile(meta, {
      path: 'new/name.ts',
      oldPath: 'old/name.ts',
    });
    expect(base.authority).toBe('base');
    expect(base.path).toBe('/acme/widgets/482/old/name.ts');
    expect(base.query).toBe('sha=base111');
    expect(head.authority).toBe('head');
    expect(head.path).toBe('/acme/widgets/482/new/name.ts');
    expect(head.query).toBe('sha=head222');
  });

  it('uses the same path on both sides for a non-rename', () => {
    const { base, head } = diffUrisForFile(meta, { path: 'a.ts' });
    expect(base.path).toBe('/acme/widgets/482/a.ts');
    expect(head.path).toBe('/acme/widgets/482/a.ts');
  });
});

describe('argusUriForSide', () => {
  it('resolves the base side of a rename through oldPath (matches diffUrisForFile)', () => {
    const file = { path: 'new/name.ts', oldPath: 'old/name.ts' };
    const base = argusUriForSide(meta, file, 'base');
    // Must equal the base doc the diff editor opens, NOT the head path.
    expect(base.toString()).toBe(diffUrisForFile(meta, file).base.toString());
    expect(base.authority).toBe('base');
    expect(base.path).toBe('/acme/widgets/482/old/name.ts');
  });

  it('resolves the head side to the head path', () => {
    const file = { path: 'new/name.ts', oldPath: 'old/name.ts' };
    const head = argusUriForSide(meta, file, 'head');
    expect(head.toString()).toBe(diffUrisForFile(meta, file).head.toString());
    expect(head.path).toBe('/acme/widgets/482/new/name.ts');
  });

  it('uses the same path on both sides for a non-rename', () => {
    const file = { path: 'a.ts' };
    expect(argusUriForSide(meta, file, 'base').path).toBe('/acme/widgets/482/a.ts');
    expect(argusUriForSide(meta, file, 'head').path).toBe('/acme/widgets/482/a.ts');
  });
});

describe('sidebar parseArgusUri matches the content-provider encoding', () => {
  it('recovers side + path from a full argus:// URI', () => {
    const uri = buildArgusUri({
      side: 'head',
      owner: 'acme',
      repo: 'widgets',
      number: 482,
      path: 'src/auth/token.ts',
      sha: 'head222',
    });
    expect(parseSidebarUri(uri)).toEqual({
      side: 'head',
      path: 'src/auth/token.ts',
    });
  });

  it('returns null for non-argus or too-short URIs', () => {
    expect(parseSidebarUri({ scheme: 'file', authority: '', path: '/x' })).toBeNull();
    expect(
      parseSidebarUri({ scheme: 'argus', authority: 'head', path: '/a/b/c' }),
    ).toBeNull();
  });
});

describe('sessionMatchesUri (self-healing restored tabs)', () => {
  const parts = parseArgusUri(
    buildArgusUri({
      side: 'head',
      owner: 'acme',
      repo: 'widgets',
      number: 482,
      path: 'src/x.ts',
      sha: 'head222',
    }),
  );

  it('matches a session whose PR identity equals the URI', () => {
    const session = { meta: { owner: 'acme', repo: 'widgets', number: 482 } };
    expect(sessionMatchesUri(session, parts)).toBe(true);
  });

  it('does not match a different PR number (tab #482 while #9 loaded)', () => {
    const session = { meta: { owner: 'acme', repo: 'widgets', number: 9 } };
    expect(sessionMatchesUri(session, parts)).toBe(false);
  });

  it('does not match a different owner/repo', () => {
    const session = { meta: { owner: 'other', repo: 'widgets', number: 482 } };
    expect(sessionMatchesUri(session, parts)).toBe(false);
  });
});

describe('errorBanner', () => {
  it('includes the side, path, and message', () => {
    const text = errorBanner('base', 'a.ts', 'boom');
    expect(text).toContain('base');
    expect(text).toContain('a.ts');
    expect(text).toContain('boom');
  });
});

describe('placeholderBanner (no session / restored diff tab)', () => {
  const parts = {
    side: 'base' as const,
    owner: 'acme',
    repo: 'widgets',
    number: 482,
    path: '.github/workflows/pr-validation.yml',
    sha: 'base111',
  };

  it('names the PR (owner/repo/number) and the actionable reload command', () => {
    const text = placeholderBanner(parts);
    expect(text).toContain('#482');
    expect(text).toContain('acme/widgets');
    expect(text).toContain('.github/workflows/pr-validation.yml');
    expect(text).toContain('ARGUS: Review PR');
  });

  it('is NOT the scary load-error text (round-trips from a real URI)', () => {
    // The exact bug: a restored argus:// diff tab produced the load-error banner.
    // The placeholder must never read as a failure.
    const uri = buildArgusUri(parts);
    const text = placeholderBanner(parseArgusUri(uri));
    expect(text).not.toContain('could not load');
    expect(text).not.toContain('No pull request is loaded');
    expect(text).not.toContain('load error');
  });
});
