import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildDigest,
  parseUnifiedDiff,
  resolveReviewTimeoutMs,
} from '@argus/engine';
import type {
  AgentResult,
  AgentRunOptions,
  ClaudeAgent,
  GhClient,
  JsonSchema,
  PullRequestMeta,
  ReviewResult,
} from '@argus/engine';

import { PrSession } from '../src/prSession';

/**
 * Bug 2: the review timeout must be scaled to digest size and overridable via
 * the `argus.reviewTimeoutSeconds` setting, then threaded into the engine call.
 * These tests capture the `timeoutMs` that `PrSession` hands the agent.
 */

const META: PullRequestMeta = {
  owner: 'acme',
  repo: 'widgets',
  number: 1,
  title: 'Test PR',
  body: '',
  baseSha: 'basesha',
  headSha: 'headsha',
  baseRef: 'main',
  headRef: 'feat',
  author: 'octocat',
};

const DIFF = [
  'diff --git a/a.ts b/a.ts',
  'index 0000000..1111111 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1,3 @@',
  ' a',
  '+b',
  ' c',
  '',
].join('\n');

const REVIEW: ReviewResult = {
  version: 1,
  summary: 'A summary.',
  intent: 'The intent.',
  critical: [],
  flow: [],
  files: [],
  hunks: [],
};

function ghStub(): GhClient {
  return {
    isAvailable: async () => true,
    isAuthed: async () => true,
    prMeta: async () => META,
    prDiff: async () => DIFF,
  } as unknown as GhClient;
}

/** Agent that records the `timeoutMs` it is called with, then succeeds. */
function capturingAgent(): {
  agent: ClaudeAgent;
  captured: () => number | undefined;
} {
  let seen: number | undefined;
  const agent = {
    isAvailable: async () => true,
    runStructured: async (
      _prompt: string,
      _schema: JsonSchema,
      opts?: AgentRunOptions,
    ) => {
      seen = opts?.timeoutMs;
      return { data: REVIEW, model: 'm', raw: '{}' } satisfies AgentResult<ReviewResult>;
    },
  } as unknown as ClaudeAgent;
  return { agent, captured: () => seen };
}

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'argus-timeout-'));
}

/** Recompute the digest the session builds, to derive the expected timeout. */
function expectedAutoTimeout(): number {
  const digest = buildDigest(parseUnifiedDiff(DIFF, META.headSha));
  return resolveReviewTimeoutMs(undefined, {
    hunkCount: digest.hunks.length,
    digestChars: digest.totalChars,
  });
}

describe('PrSession threads a size-scaled review timeout into the agent', () => {
  it('uses the auto (computed) timeout when the setting is unset', async () => {
    const { agent, captured } = capturingAgent();
    const session = await PrSession.load({
      owner: 'acme',
      repo: 'widgets',
      number: 1,
      storageDir: await tmpDir(),
      gh: ghStub(),
      agent,
      reviewTimeoutSeconds: () => undefined,
    });
    await session.reviewSettled();

    expect(captured()).toBe(expectedAutoTimeout());
    // Regardless of exact arithmetic, it must beat the old fixed 90s default.
    expect(captured()).toBeGreaterThan(90_000);

    session.dispose();
  });

  it('lets a positive setting override the computed timeout', async () => {
    const { agent, captured } = capturingAgent();
    const session = await PrSession.load({
      owner: 'acme',
      repo: 'widgets',
      number: 1,
      storageDir: await tmpDir(),
      gh: ghStub(),
      agent,
      reviewTimeoutSeconds: () => 420,
    });
    await session.reviewSettled();

    expect(captured()).toBe(420_000);

    session.dispose();
  });

  it('turns a timeout failure into an actionable error (setting + regenerate)', async () => {
    const agent = {
      isAvailable: async () => true,
      runStructured: async () => {
        throw new Error('Claude Code timed out.');
      },
    } as unknown as ClaudeAgent;

    const session = await PrSession.load({
      owner: 'acme',
      repo: 'widgets',
      number: 1,
      storageDir: await tmpDir(),
      gh: ghStub(),
      agent,
      reviewTimeoutSeconds: () => undefined,
    });
    await session.reviewSettled();

    expect(session.reviewStatus).toBe('error');
    expect(session.review).toBeNull();
    const err = session.reviewError ?? '';
    expect(err).toMatch(/timed out after \d+s/);
    expect(err).toContain('argus.reviewTimeoutSeconds');
    expect(err).toContain('Regenerate Review');

    session.dispose();
  });

  it('re-reads the setting on regenerate (a live change takes effect)', async () => {
    const { agent, captured } = capturingAgent();
    let configured: number | undefined = undefined;
    const session = await PrSession.load({
      owner: 'acme',
      repo: 'widgets',
      number: 1,
      storageDir: await tmpDir(),
      gh: ghStub(),
      agent,
      reviewTimeoutSeconds: () => configured,
    });
    await session.reviewSettled();
    expect(captured()).toBe(expectedAutoTimeout());

    // User raises the setting, then regenerates — the new value must be used.
    configured = 600;
    await session.regenerate();
    expect(captured()).toBe(600_000);

    session.dispose();
  });
});
