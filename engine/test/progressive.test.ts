import { describe, expect, it } from 'vitest';

import {
  FILE_DIGEST_BUDGET,
  PER_FILE_TIMEOUT_MS,
  buildFileReviewPrompt,
  buildFileReviewSchema,
  buildIntentPrompt,
  buildDigest,
  humanizeAgentError,
  intentSchema,
  isMechanicalFile,
  mechanicalNote,
  orderForReview,
  runProgressiveReview,
  sanitizeNote,
} from '../src/index.js';
import type {
  AgentResult,
  AgentRunOptions,
  FileChange,
  FileReviewState,
  IntentResult,
  JsonSchema,
  NormalizedReview,
  ProgressiveAgent,
  PullRequestMeta,
} from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const META: PullRequestMeta = {
  owner: 'acme',
  repo: 'widgets',
  number: 7,
  title: 'Add rate limiter',
  body: 'Limits request bursts.',
  baseSha: 'base0000',
  headSha: 'head1111',
  baseRef: 'main',
  headRef: 'feat/limiter',
  author: 'octocat',
};

function makeFile(path: string, hunkCount = 1): FileChange {
  const hunks = Array.from({ length: hunkCount }, (_, i) => ({
    id: `${path}:head1111:h${i + 1}`,
    oldStart: 1 + i * 10,
    oldLines: 2,
    newStart: 1 + i * 10,
    newLines: 3,
    patch: `@@ -${1 + i * 10},2 +${1 + i * 10},3 @@\n a\n+b${i}\n c`,
  }));
  return {
    path,
    status: 'modified',
    additions: hunkCount,
    deletions: 0,
    hunks,
  };
}

const INTENT: IntentResult = {
  summary: 'Adds a limiter.',
  intent: 'Prevent bursts.',
  critical: ['CI workflow changed'],
  flow: ['read src first'],
};

/** Payload the stub agent returns for a per-file call, covering all aliases. */
function filePayloadFor(schema: JsonSchema): unknown {
  const hunks = (schema as { properties: { hunks: { minItems?: number } } })
    .properties.hunks;
  const n = hunks.minItems ?? 0;
  return {
    role: 'core',
    note: 'Implements the limiter.',
    bucket: 'Core logic',
    hunks: Array.from({ length: n }, (_, i) => ({
      hunkId: `h${i + 1}`,
      why: `Change ${i + 1} exists for the limiter.`,
      lookout: `Verify branch ${i + 1}.`,
      importance: 'normal',
    })),
  };
}

/** Is this schema the intent schema (vs a per-file schema)? */
function isIntentSchema(schema: JsonSchema): boolean {
  return (
    Array.isArray((schema as { required?: string[] }).required) &&
    (schema as { required: string[] }).required.includes('summary')
  );
}

interface StubOptions {
  /** Reject per-file calls for these paths (path is sniffed from the prompt). */
  readonly failPaths?: readonly string[];
  /** Reject the intent call. */
  readonly failIntent?: boolean;
  /** Called on every runStructured with (kind, path|null). */
  readonly onCall?: (kind: 'intent' | 'file', path: string | null) => void;
  /** Resolve delay in ms (to observe concurrency). */
  readonly delayMs?: number;
}

function stubAgent(opts: StubOptions = {}): ProgressiveAgent & {
  calls: { kind: 'intent' | 'file'; path: string | null }[];
  live: number;
  maxLive: number;
} {
  const state = {
    calls: [] as { kind: 'intent' | 'file'; path: string | null }[],
    live: 0,
    maxLive: 0,
    async runStructured<T>(
      prompt: string,
      schema: JsonSchema,
      _opts?: AgentRunOptions,
    ): Promise<AgentResult<T>> {
      const kind = isIntentSchema(schema) ? 'intent' : 'file';
      const path =
        kind === 'file'
          ? (/Review ONE file\nof a larger PR: `([^`]+)`/.exec(prompt)?.[1] ?? null)
          : null;
      state.calls.push({ kind, path });
      opts.onCall?.(kind, path);

      state.live += 1;
      state.maxLive = Math.max(state.maxLive, state.live);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      state.live -= 1;

      if (kind === 'intent' && opts.failIntent) {
        throw new Error('intent boom');
      }
      if (kind === 'file' && path && opts.failPaths?.includes(path)) {
        throw new Error(`file boom: ${path}`);
      }
      const data = kind === 'intent' ? INTENT : filePayloadFor(schema);
      return { data: data as T, model: 'stub', raw: '{}' };
    },
  };
  return state;
}

function memCache(): {
  hash(c: string): string;
  get(k: string): Promise<unknown>;
  set(k: string, v: unknown): Promise<void>;
  store: Map<string, unknown>;
} {
  const store = new Map<string, unknown>();
  return {
    store,
    hash: (c) => `k${c.length}:${c.slice(0, 40)}:${c.slice(-40)}`,
    get: async (k) => store.get(k),
    set: async (k, v) => void store.set(k, v),
  };
}

/* -------------------------------------------------------------------------- */
/* Ordering + mechanical detection                                             */
/* -------------------------------------------------------------------------- */

describe('orderForReview', () => {
  it('orders source before tests before config before generated', () => {
    const files = [
      makeFile('pnpm-lock.yaml'),
      makeFile('.github/workflows/ci.yml'),
      makeFile('src/limiter.ts'),
      makeFile('src/limiter.test.ts'),
    ];
    expect(orderForReview(files).map((f) => f.path)).toEqual([
      'src/limiter.ts',
      'src/limiter.test.ts',
      '.github/workflows/ci.yml',
      'pnpm-lock.yaml',
    ]);
  });
});

describe('isMechanicalFile / mechanicalNote', () => {
  it('lockfiles and dist output are mechanical; source is not', () => {
    expect(isMechanicalFile('pnpm-lock.yaml')).toBe(true);
    expect(isMechanicalFile('dist/bundle.min.js')).toBe(true);
    expect(isMechanicalFile('src/limiter.ts')).toBe(false);
  });

  it('lockfiles get the manifest-match note; other generated files a source note', () => {
    expect(mechanicalNote('pnpm-lock.yaml').lookout).toMatch(/manifest/i);
    expect(mechanicalNote('dist/out.min.js').lookout).toMatch(/source/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Note sanitation                                                             */
/* -------------------------------------------------------------------------- */

describe('sanitizeNote', () => {
  it('replaces degenerate notes with an honest fallback', () => {
    for (const bad of ['Truncated.', '[truncated]', 'truncated', 'N/A', ' - ', '…', '']) {
      expect(sanitizeNote(bad, 'lookout')).toMatch(/open the full diff/i);
      expect(sanitizeNote(bad, 'why')).toMatch(/no specific rationale/i);
    }
  });

  it('keeps real notes verbatim', () => {
    expect(sanitizeNote('Verify the retry path.', 'lookout')).toBe(
      'Verify the retry path.',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Prompts / schemas                                                           */
/* -------------------------------------------------------------------------- */

describe('prompts and schemas', () => {
  it('intent prompt carries title, body, and the file list; schema requires the overview', () => {
    const prompt = buildIntentPrompt(META, [makeFile('src/a.ts')]);
    expect(prompt).toContain(META.title);
    expect(prompt).toContain('src/a.ts');
    expect((intentSchema as { required: string[] }).required).toEqual([
      'summary',
      'intent',
      'critical',
      'flow',
    ]);
  });

  it('file prompt scopes to one file, injects intent as data, and bans quota padding', () => {
    const file = makeFile('src/a.ts', 2);
    const digest = buildDigest([file], FILE_DIGEST_BUDGET);
    const prompt = buildFileReviewPrompt(META, INTENT, file, digest);
    expect(prompt).toContain('`src/a.ts`');
    expect(prompt).toContain('<pr-intent>');
    expect(prompt).toMatch(/do not pad/i);
    expect(prompt).toMatch(/never output "truncated\."/i);
    expect(prompt).toContain('h1, h2');
  });

  it('file schema binds minItems to the hunk count', () => {
    const schema = buildFileReviewSchema(3) as {
      properties: { hunks: { minItems?: number } };
    };
    expect(schema.properties.hunks.minItems).toBe(3);
    const unbounded = buildFileReviewSchema(0) as {
      properties: { hunks: { minItems?: number } };
    };
    expect(unbounded.properties.hunks.minItems).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* humanizeAgentError                                                          */
/* -------------------------------------------------------------------------- */

describe('humanizeAgentError', () => {
  it('maps login failures to a /login call to action', () => {
    expect(humanizeAgentError('Error: not logged in')).toMatch(/\/login/);
    expect(humanizeAgentError('authentication_error: oauth token expired')).toMatch(
      /not logged in/i,
    );
  });

  it('maps rate limits / overload to a try-again message', () => {
    expect(humanizeAgentError('HTTP 429 rate limit exceeded')).toMatch(/usage limit/i);
    expect(humanizeAgentError('Claude usage limit reached until 5pm')).toMatch(
      /try again/i,
    );
  });

  it('passes other messages through unchanged', () => {
    expect(humanizeAgentError('Claude Code exited with code 1.')).toBe(
      'Claude Code exited with code 1.',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                                */
/* -------------------------------------------------------------------------- */

describe('runProgressiveReview', () => {
  const FILES = [
    makeFile('src/limiter.ts', 2),
    makeFile('src/limiter.test.ts'),
    makeFile('pnpm-lock.yaml', 1),
  ];

  it('reviews per file: intent first, one call per non-mechanical file, lockfile synthesized', async () => {
    const agent = stubAgent();
    const result = await runProgressiveReview({
      meta: META,
      files: FILES,
      agent,
      model: 'm',
    });

    // 1 intent + 2 file calls; the lockfile never reaches the agent.
    expect(agent.calls.filter((c) => c.kind === 'intent')).toHaveLength(1);
    expect(agent.calls.filter((c) => c.kind === 'file').map((c) => c.path).sort()).toEqual(
      ['src/limiter.test.ts', 'src/limiter.ts'],
    );
    expect(agent.calls[0]!.kind).toBe('intent');

    // Overview comes from the intent pass.
    expect(result.review.review.summary).toBe(INTENT.summary);
    expect(result.review.review.critical).toEqual(INTENT.critical);

    // Every file has a slice; every hunk is anchored; nothing uncovered.
    expect(result.review.review.files.map((f) => f.path)).toEqual([
      'src/limiter.ts',
      'src/limiter.test.ts',
      'pnpm-lock.yaml',
    ]);
    expect(result.review.anchored).toHaveLength(4); // 2 + 1 + 1 hunks
    expect(result.review.uncoveredHunkIds).toEqual([]);

    // Lockfile notes are the synthesized mechanical ones.
    const lock = result.review.anchored.find((a) => a.path === 'pnpm-lock.yaml')!;
    expect(lock.lookout).toMatch(/manifest/i);
    expect(lock.importance).toBe('context');

    // All ready.
    expect(
      Object.values(result.fileStates).every((s) => s.status === 'ready'),
    ).toBe(true);
  });

  it('caps concurrency at the pool width', async () => {
    const files = Array.from({ length: 6 }, (_, i) => makeFile(`src/f${i}.ts`));
    const agent = stubAgent({ delayMs: 10 });
    await runProgressiveReview({
      meta: META,
      files,
      agent,
      model: 'm',
      concurrency: 2,
    });
    // The intent call runs alone; file calls run at most 2 wide.
    expect(agent.maxLive).toBeLessThanOrEqual(2);
  });

  it('isolates per-file failures: one file errors (humanized), the rest land', async () => {
    const agent = stubAgent({ failPaths: ['src/limiter.ts'] });
    const states: Record<string, FileReviewState> = {};
    const result = await runProgressiveReview(
      { meta: META, files: FILES, agent, model: 'm' },
      { onFileState: (path, s) => void (states[path] = s) },
    );

    expect(result.fileStates['src/limiter.ts']!.status).toBe('error');
    expect(result.fileStates['src/limiter.ts']!.error).toContain('file boom');
    expect(result.fileStates['src/limiter.test.ts']!.status).toBe('ready');
    expect(result.fileStates['pnpm-lock.yaml']!.status).toBe('ready');

    // The failed file contributes no notes but the others do.
    expect(
      result.review.anchored.some((a) => a.path === 'src/limiter.ts'),
    ).toBe(false);
    expect(
      result.review.anchored.some((a) => a.path === 'src/limiter.test.ts'),
    ).toBe(true);
    expect(states['src/limiter.ts']!.status).toBe('error');
  });

  it('proceeds ungrounded when the intent pass fails', async () => {
    const agent = stubAgent({ failIntent: true });
    const result = await runProgressiveReview({
      meta: META,
      files: FILES,
      agent,
      model: 'm',
    });
    expect(result.intentError).toContain('intent boom');
    // Files still reviewed.
    expect(result.fileStates['src/limiter.ts']!.status).toBe('ready');
    // Fallback overview text, never fabricated model output.
    expect(result.review.review.summary).toMatch(/3 changed file/);
    expect(result.review.review.critical).toEqual([]);
  });

  it('sanitizes degenerate notes from the model', async () => {
    const agent: ProgressiveAgent = {
      async runStructured<T>(_p: string, schema: JsonSchema): Promise<AgentResult<T>> {
        if (isIntentSchema(schema)) return { data: INTENT as T, model: 'm', raw: '' };
        return {
          data: {
            role: 'core',
            note: 'n',
            bucket: 'Core logic',
            hunks: [
              { hunkId: 'h1', why: 'loop.ts continued.', lookout: 'Truncated.', importance: 'normal' },
            ],
          } as T,
          model: 'm',
          raw: '',
        };
      },
    };
    const result = await runProgressiveReview({
      meta: META,
      files: [makeFile('src/a.ts', 1)],
      agent,
      model: 'm',
    });
    const note = result.review.anchored[0]!;
    expect(note.lookout).not.toMatch(/^truncated\.?$/i);
    expect(note.lookout).toMatch(/open the full diff/i);
    // A non-degenerate (if lazy) "why" passes through — sanitation only replaces
    // contentless stubs, it does not rewrite prose.
    expect(note.why).toBe('loop.ts continued.');
  });

  it('serves per-file slices from cache and skips the agent; bypassCache forces calls', async () => {
    const cache = memCache();
    const agent1 = stubAgent();
    const first = await runProgressiveReview({
      meta: META,
      files: FILES,
      agent: agent1,
      model: 'm',
      cache,
    });
    expect(first.review.anchored).toHaveLength(4);
    expect(agent1.calls.filter((c) => c.kind === 'file')).toHaveLength(2);

    // Second run: cache hits — no per-file agent calls, and the intent pass is
    // cached too, so zero calls total.
    const agent2 = stubAgent();
    const second = await runProgressiveReview({
      meta: META,
      files: FILES,
      agent: agent2,
      model: 'm',
      cache,
    });
    expect(agent2.calls).toHaveLength(0);
    expect(second.review.anchored).toHaveLength(4);
    expect(
      Object.values(second.fileStates).every((s) => s.status === 'ready'),
    ).toBe(true);

    // bypassCache re-runs everything.
    const agent3 = stubAgent();
    await runProgressiveReview({
      meta: META,
      files: FILES,
      agent: agent3,
      model: 'm',
      cache,
      bypassCache: true,
    });
    expect(agent3.calls.filter((c) => c.kind === 'file')).toHaveLength(2);
    expect(agent3.calls.filter((c) => c.kind === 'intent')).toHaveLength(1);
  });

  it('retries a single file via onlyPaths + prior, keeping every other slice', async () => {
    const agent1 = stubAgent({ failPaths: ['src/limiter.ts'] });
    const first = await runProgressiveReview({
      meta: META,
      files: FILES,
      agent: agent1,
      model: 'm',
    });
    expect(first.fileStates['src/limiter.ts']!.status).toBe('error');

    const agent2 = stubAgent();
    const second = await runProgressiveReview({
      meta: META,
      files: FILES,
      agent: agent2,
      model: 'm',
      onlyPaths: ['src/limiter.ts'],
      prior: first,
      bypassCache: true,
    });

    // Only the retried file was called; no new intent pass.
    expect(agent2.calls).toEqual([{ kind: 'file', path: 'src/limiter.ts' }]);
    expect(second.fileStates['src/limiter.ts']!.status).toBe('ready');
    expect(second.fileStates['src/limiter.test.ts']!.status).toBe('ready');
    // Full coverage after the retry.
    expect(second.review.anchored).toHaveLength(4);
    // Intent carried over from the prior run.
    expect(second.review.review.summary).toBe(INTENT.summary);
  });

  it('onlyPaths without prior is a programmer error', async () => {
    await expect(
      runProgressiveReview({
        meta: META,
        files: FILES,
        agent: stubAgent(),
        model: 'm',
        onlyPaths: ['src/limiter.ts'],
      }),
    ).rejects.toThrow(/prior/);
  });

  it('fires snapshots as files land, each a valid merged review', async () => {
    const snapshots: NormalizedReview[] = [];
    await runProgressiveReview(
      { meta: META, files: FILES, agent: stubAgent(), model: 'm' },
      { onSnapshot: (r) => void snapshots.push(r) },
    );
    // 1 after intent + 1 per AI file (2). Mechanical files are folded into the
    // first snapshot.
    expect(snapshots.length).toBe(3);
    // Monotonically non-decreasing coverage.
    const counts = snapshots.map((s) => s.anchored.length);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
    // First snapshot (post-intent) already carries the overview + lockfile note.
    expect(snapshots[0]!.review.summary).toBe(INTENT.summary);
    expect(snapshots[0]!.anchored.some((a) => a.path === 'pnpm-lock.yaml')).toBe(true);
  });

  it('threads the per-file timeout override into every file call', async () => {
    const seen: (number | undefined)[] = [];
    const agent: ProgressiveAgent = {
      async runStructured<T>(
        _p: string,
        schema: JsonSchema,
        opts?: AgentRunOptions,
      ): Promise<AgentResult<T>> {
        if (!isIntentSchema(schema)) seen.push(opts?.timeoutMs);
        const data = isIntentSchema(schema) ? INTENT : filePayloadFor(schema);
        return { data: data as T, model: 'm', raw: '' };
      },
    };
    await runProgressiveReview({
      meta: META,
      files: [makeFile('src/a.ts')],
      agent,
      model: 'm',
    });
    await runProgressiveReview({
      meta: META,
      files: [makeFile('src/a.ts')],
      agent,
      model: 'm',
      perFileTimeoutMs: 300_000,
    });
    expect(seen).toEqual([PER_FILE_TIMEOUT_MS, 300_000]);
  });
});
