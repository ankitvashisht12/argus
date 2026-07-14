/**
 * On-disk persistence for the ARGUS engine. Two stores live here:
 *
 * - {@link ReviewCache}: a content-addressed cache of {@link NormalizedReview}s,
 *   so reopening a PR at the same revision is instant and skips claude.
 * - {@link KeyValueStore}: a tiny JSON-file map for per-PR UI state (reviewed
 *   file paths, chat history) the extension keeps across window reloads.
 *
 * Both write atomically (write a uniquely-named temp file, then `rename` onto
 * the target — `rename` is atomic on a single filesystem), so a crash mid-write
 * can never leave a partially-written or corrupt file at the real path. Reads
 * of missing/corrupt/unreadable files degrade to "empty" and never throw.
 *
 * Pure Node — no `vscode`. Uses only `node:crypto` and `node:fs/promises`.
 *
 * @module
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { NormalizedReview } from '../types.js';

/* -------------------------------------------------------------------------- */
/* Shared helpers (pure)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Deterministically serialize a JSON value with object keys sorted recursively,
 * so two logically-equal values that differ only in key insertion order produce
 * byte-identical output (and therefore identical cache hashes).
 *
 * Arrays keep their order (order is meaningful). `undefined` values and
 * function/symbol values follow `JSON.stringify` semantics.
 *
 * @param value Any JSON-serializable value.
 * @returns A canonical JSON string.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Recursively rebuild a value with all plain-object keys sorted. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

/** Lowercase hex sha256 digest of a string. */
function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Write `data` to `filePath` atomically: create the parent directory, write to
 * a unique temp sibling, then `rename` it onto the target. If anything fails
 * before the rename, the temp file is cleaned up and the target is left
 * untouched — so the destination is never partially written.
 *
 * @param filePath Absolute or relative destination path.
 * @param data     File contents.
 */
async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, data, 'utf8');
    await rename(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup; the target path was never touched.
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* ReviewCache                                                                 */
/* -------------------------------------------------------------------------- */

/** Options for constructing a {@link ReviewCache}. */
export interface ReviewCacheOptions {
  /** Directory the cache writes JSON entries into (created if missing). */
  readonly dir: string;
}

/**
 * A content-addressed cache of {@link NormalizedReview}s.
 *
 * Keys are sha256 hashes of the review inputs (diff + prompt-affecting
 * metadata), computed by {@link ReviewCache.hash}. Callers that key off a
 * structured object should first canonicalize it with {@link stableStringify}
 * so key ordering does not perturb the hash. Entries persist as JSON files
 * named `<key>.json` under the configured directory.
 */
export class ReviewCache {
  readonly #dir: string;

  /**
   * @param options Cache configuration (target directory).
   */
  constructor(options: ReviewCacheOptions) {
    this.#dir = options.dir;
  }

  /**
   * Compute the sha256 cache key for the given content.
   *
   * @param content The canonical string to hash (e.g. `stableStringify(...)`).
   * @returns Lowercase hex sha256 digest.
   */
  hash(content: string): string {
    return sha256Hex(content);
  }

  /**
   * Read a cached review by key. A miss, an unreadable file, or a corrupt
   * (non-JSON) entry all resolve to `undefined` — this never throws.
   *
   * @param key A sha256 key from {@link ReviewCache.hash}.
   * @returns The cached review, or `undefined` on a miss/corrupt entry.
   */
  async get(key: string): Promise<NormalizedReview | undefined> {
    let text: string;
    try {
      text = await readFile(this.#entryPath(key), 'utf8');
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(text) as NormalizedReview;
    } catch {
      return undefined;
    }
  }

  /**
   * Write a review under the given key (atomic temp-file + rename).
   *
   * @param key    A sha256 key from {@link ReviewCache.hash}.
   * @param review The normalized review to persist.
   */
  async set(key: string, review: NormalizedReview): Promise<void> {
    const data = JSON.stringify(review);
    await atomicWriteFile(this.#entryPath(key), data);
  }

  /** Absolute path of the JSON entry file for a key. */
  #entryPath(key: string): string {
    return join(this.#dir, `${key}.json`);
  }
}

/* -------------------------------------------------------------------------- */
/* KeyValueStore                                                               */
/* -------------------------------------------------------------------------- */

/** Options for constructing a {@link KeyValueStore}. */
export interface KeyValueStoreOptions {
  /** Path of the backing JSON file (created/overwritten atomically). */
  readonly file: string;
}

/**
 * A tiny JSON-file-backed string→value map for durable per-PR UI state such as
 * the set of reviewed file paths or the chat transcript.
 *
 * The whole map lives in one file. Every mutation reads the current map, applies
 * the change, and writes the result back atomically. Mutations are serialized
 * through an internal promise chain so concurrent `set`/`delete` calls cannot
 * interleave their read-modify-write cycles and lose updates. A missing or
 * corrupt backing file is treated as an empty map (reads never throw).
 */
export class KeyValueStore {
  readonly #file: string;
  /** Tail of the write queue; each mutation chains onto the previous one. */
  #queue: Promise<void> = Promise.resolve();

  /**
   * @param options Store configuration (backing file path).
   */
  constructor(options: KeyValueStoreOptions) {
    this.#file = options.file;
  }

  /**
   * Read the value stored under `key`.
   *
   * @param key Entry key.
   * @returns The stored value, or `undefined` if absent.
   */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const map = await this.#read();
    return Object.prototype.hasOwnProperty.call(map, key)
      ? (map[key] as T)
      : undefined;
  }

  /**
   * Store `value` under `key` (atomic, serialized).
   *
   * @param key   Entry key.
   * @param value Any JSON-serializable value.
   */
  async set(key: string, value: unknown): Promise<void> {
    return this.#mutate((map) => {
      // Serialize the value eagerly so a non-serializable value rejects the
      // mutation *before* the backing file is touched.
      map[key] = JSON.parse(JSON.stringify(value)) as unknown;
    });
  }

  /**
   * Remove `key` if present (atomic, serialized).
   *
   * @param key Entry key.
   */
  async delete(key: string): Promise<void> {
    return this.#mutate((map) => {
      delete map[key];
    });
  }

  /**
   * Snapshot the entire map.
   *
   * @returns A shallow copy of all stored entries.
   */
  async all(): Promise<Record<string, unknown>> {
    return this.#read();
  }

  /** Serialize a read-modify-write cycle onto the queue. */
  #mutate(apply: (map: Record<string, unknown>) => void): Promise<void> {
    const run = this.#queue.then(async () => {
      const map = await this.#read();
      apply(map);
      await atomicWriteFile(this.#file, JSON.stringify(map));
    });
    // Keep the queue alive even if this mutation rejects.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Load the backing map, treating missing/corrupt files as empty. */
  async #read(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }
}
