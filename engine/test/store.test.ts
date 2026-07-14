/**
 * Behavioral tests for the on-disk stores (contract item 8).
 *
 * Covers: round-trip persistence, cache-key stability across object key-order
 * permutations, corrupt/unreadable files degrading to empty, and the
 * atomic-write invariant (a failed write leaves no partial file at the target
 * and no stray temp files behind). No network, no claude, no gh.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  KeyValueStore,
  ReviewCache,
  stableStringify,
} from '../src/store/cache.js';
import type { NormalizedReview } from '../src/types.js';

/** Build a minimal, valid NormalizedReview fixture. */
function makeReview(summary = 'does a thing'): NormalizedReview {
  return {
    review: {
      version: 1,
      summary,
      intent: 'wire up the widget',
      critical: ['check the null path'],
      flow: ['entry', 'exit'],
      files: [{ path: 'a.ts', role: 'entry point', note: 'main change' }],
      hunks: [
        { hunkId: 'h1', why: 'adds guard', lookout: 'off-by-one', importance: 'critical' },
      ],
    },
    anchored: [
      {
        hunkId: 'h1',
        why: 'adds guard',
        lookout: 'off-by-one',
        importance: 'critical',
        path: 'a.ts',
        startLine: 10,
        endLine: 12,
        side: 'new',
      },
    ],
    uncoveredHunkIds: ['a.ts:deadbeef:h2'],
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'argus-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('stableStringify', () => {
  it('is invariant to object key insertion order (nested)', () => {
    const a = { z: 1, a: { y: 2, x: 3 }, list: [{ b: 1, a: 2 }] };
    const b = { list: [{ a: 2, b: 1 }], a: { x: 3, y: 2 }, z: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('preserves array element order (order is meaningful)', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });
});

describe('ReviewCache', () => {
  it('round-trips a review through set/get', async () => {
    const cache = new ReviewCache({ dir });
    const key = cache.hash('some-content');
    expect(await cache.get(key)).toBeUndefined();

    const review = makeReview();
    await cache.set(key, review);
    expect(await cache.get(key)).toEqual(review);
  });

  it('produces a stable 64-hex key equal for permuted content objects', async () => {
    const cache = new ReviewCache({ dir });
    const k1 = cache.hash(stableStringify({ owner: 'o', repo: 'r', sha: 'abc' }));
    const k2 = cache.hash(stableStringify({ sha: 'abc', repo: 'r', owner: 'o' }));
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates the cache directory on first write', async () => {
    const nested = join(dir, 'a', 'b', 'c');
    const cache = new ReviewCache({ dir: nested });
    const key = cache.hash('x');
    await cache.set(key, makeReview());
    expect(await cache.get(key)).toEqual(makeReview());
  });

  it('returns undefined for a corrupt (non-JSON) entry, never throws', async () => {
    const cache = new ReviewCache({ dir });
    const key = cache.hash('corrupt');
    await writeFile(join(dir, `${key}.json`), '{ this is not: json', 'utf8');
    expect(await cache.get(key)).toBeUndefined();
  });

  it('leaves no partial file and preserves the prior entry on a failed write', async () => {
    const cache = new ReviewCache({ dir });
    const key = cache.hash('key');
    const good = makeReview('original');
    await cache.set(key, good);

    // A non-serializable value fails the write; the target must be untouched.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      cache.set(key, circular as unknown as NormalizedReview),
    ).rejects.toThrow();

    expect(await cache.get(key)).toEqual(good);
    const entries = await readdir(dir);
    expect(entries).toEqual([`${key}.json`]); // no leftover *.tmp
  });
});

describe('KeyValueStore', () => {
  it('round-trips values and reports absence', async () => {
    const store = new KeyValueStore({ file: join(dir, 'state.json') });
    expect(await store.get('reviewed')).toBeUndefined();

    await store.set('reviewed', ['a.ts', 'b.ts']);
    await store.set('chat', [{ role: 'user', text: 'hi' }]);
    expect(await store.get<string[]>('reviewed')).toEqual(['a.ts', 'b.ts']);
    expect(await store.get('chat')).toEqual([{ role: 'user', text: 'hi' }]);
    expect(await store.all()).toEqual({
      reviewed: ['a.ts', 'b.ts'],
      chat: [{ role: 'user', text: 'hi' }],
    });
  });

  it('deletes keys', async () => {
    const store = new KeyValueStore({ file: join(dir, 'state.json') });
    await store.set('k', 1);
    await store.delete('k');
    expect(await store.get('k')).toBeUndefined();
  });

  it('treats a missing or corrupt backing file as empty (never throws)', async () => {
    const file = join(dir, 'state.json');
    const store = new KeyValueStore({ file });
    expect(await store.all()).toEqual({});

    await writeFile(file, 'not valid json at all', 'utf8');
    expect(await store.all()).toEqual({});
    expect(await store.get('anything')).toBeUndefined();
  });

  it('serializes concurrent writes without losing updates', async () => {
    const store = new KeyValueStore({ file: join(dir, 'state.json') });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.set(`k${i}`, i)),
    );
    const all = await store.all();
    expect(Object.keys(all)).toHaveLength(20);
    expect(all.k0).toBe(0);
    expect(all.k19).toBe(19);
  });

  it('leaves no partial file and preserves prior state on a failed write', async () => {
    const file = join(dir, 'state.json');
    const store = new KeyValueStore({ file });
    await store.set('keep', 'me');

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(store.set('bad', circular)).rejects.toThrow();

    // The store must still be usable and hold the prior value.
    expect(await store.get('keep')).toBe('me');
    expect(await store.get('bad')).toBeUndefined();
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as unknown;
    expect(onDisk).toEqual({ keep: 'me' });
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
