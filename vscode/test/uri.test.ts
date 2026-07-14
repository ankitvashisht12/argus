import { describe, expect, it } from 'vitest';

import {
  buildArgusUri,
  diffUrisForFile,
  errorBanner,
  parseArgusUri,
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

describe('errorBanner', () => {
  it('includes the side, path, and message', () => {
    const text = errorBanner('base', 'a.ts', 'boom');
    expect(text).toContain('base');
    expect(text).toContain('a.ts');
    expect(text).toContain('boom');
  });
});
