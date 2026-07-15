import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  AgentResult,
  ClaudeAgent,
  GhClient,
  PullRequestMeta,
  ReviewResult,
} from '@argus/engine';

import { PrSession } from '../src/prSession';

/**
 * Progressive-loading contract (v0.1.2): `PrSession.load` resolves as soon as the
 * PR is fetched + parsed (files/diff usable), with the AI review running in the
 * background. These tests drive the transitions with stubbed `gh`/`claude`.
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

function agentStub(available: boolean): ClaudeAgent {
  return {
    isAvailable: async () => available,
    runStructured: async () =>
      ({ data: REVIEW, model: 'm', raw: '{}' } satisfies AgentResult<ReviewResult>),
  } as unknown as ClaudeAgent;
}

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'argus-status-'));
}

describe('PrSession progressive loading', () => {
  it('resolves with files ready and the review still running in the background', async () => {
    const session = await PrSession.load({
      owner: 'acme',
      repo: 'widgets',
      number: 1,
      storageDir: await tmpDir(),
      gh: ghStub(),
      agent: agentStub(true),
    });

    // Stage 1 is done: the diff is usable immediately.
    expect(session.files.length).toBeGreaterThan(0);
    // Stage 2 has started but not finished.
    expect(session.reviewStatus).toBe('running');
    expect(session.review).toBeNull();

    await session.reviewSettled();

    expect(session.reviewStatus).toBe('ready');
    expect(session.review).not.toBeNull();
    expect(session.reviewError).toBeNull();

    session.dispose();
  });

  it('lands in the error state (never empty success) when claude is unavailable', async () => {
    const session = await PrSession.load({
      owner: 'acme',
      repo: 'widgets',
      number: 1,
      storageDir: await tmpDir(),
      gh: ghStub(),
      agent: agentStub(false),
    });

    // (No 'running' assertion here: the unavailable-agent path settles within
    // a few microtasks, racing the check. The settled state is the contract.)
    await session.reviewSettled();

    // Contract 19: errored review is null + reviewError set, never a fake empty
    // successful review.
    expect(session.reviewStatus).toBe('error');
    expect(session.review).toBeNull();
    expect(session.reviewError).not.toBeNull();

    session.dispose();
  });

  it('regenerate reuses the background path: running, then ready', async () => {
    const session = await PrSession.load({
      owner: 'acme',
      repo: 'widgets',
      number: 1,
      storageDir: await tmpDir(),
      gh: ghStub(),
      agent: agentStub(true),
    });
    await session.reviewSettled();
    expect(session.reviewStatus).toBe('ready');

    const inFlight = session.regenerate();
    expect(session.reviewStatus).toBe('running');
    await inFlight;
    expect(session.reviewStatus).toBe('ready');

    session.dispose();
  });

  it('a demo/fixture session is ready at load (no running phase)', async () => {
    const session = await PrSession.loadDemo();
    expect(session.reviewStatus).toBe('ready');
    expect(session.review).not.toBeNull();
    session.dispose();
  });
});
