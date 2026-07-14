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
import type { PersistedDraft } from '../src/prSession';

/**
 * Draft-comment persistence (v0.1.4): drafts serialized via
 * {@link PrSession.saveDrafts} survive a window reload — a fresh session for the
 * SAME PR (same storage dir + owner/repo/number → same state file) restores them
 * through {@link PrSession.drafts}.
 */

const META: PullRequestMeta = {
  owner: 'acme',
  repo: 'widgets',
  number: 7,
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

function agentStub(): ClaudeAgent {
  return {
    isAvailable: async () => true,
    runStructured: async () =>
      ({ data: REVIEW, model: 'm', raw: '{}' } satisfies AgentResult<ReviewResult>),
  } as unknown as ClaudeAgent;
}

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'argus-drafts-'));
}

const DRAFTS: PersistedDraft[] = [
  { path: 'a.ts', line: 2, side: 'head', body: 'Consider a null check here.' },
  { path: 'a.ts', line: 1, side: 'base', body: 'Was this intentional?' },
];

describe('PrSession draft persistence', () => {
  it('restores saved drafts in a fresh session for the same PR', async () => {
    const storageDir = await tmpDir();
    const load = (): Promise<PrSession> =>
      PrSession.load({
        owner: 'acme',
        repo: 'widgets',
        number: 7,
        storageDir,
        gh: ghStub(),
        agent: agentStub(),
      });

    const first = await load();
    expect(first.drafts).toEqual([]); // nothing persisted yet
    await first.saveDrafts(DRAFTS);
    await first.reviewSettled();
    first.dispose();

    // Simulate a window reload: a brand-new session for the same PR + storage.
    const reloaded = await load();
    expect(reloaded.drafts).toEqual(DRAFTS);
    reloaded.dispose();
  });

  it('clears persisted drafts when saved with an empty list (post-submit)', async () => {
    const storageDir = await tmpDir();
    const load = (): Promise<PrSession> =>
      PrSession.load({
        owner: 'acme',
        repo: 'widgets',
        number: 7,
        storageDir,
        gh: ghStub(),
        agent: agentStub(),
      });

    const first = await load();
    await first.saveDrafts(DRAFTS);
    await first.saveDrafts([]); // successful submit clears them
    first.dispose();

    const reloaded = await load();
    expect(reloaded.drafts).toEqual([]);
    reloaded.dispose();
  });

  it('a demo session accepts saveDrafts without persistence and keeps the snapshot', async () => {
    const session = await PrSession.loadDemo();
    expect(session.drafts).toEqual([]);
    await session.saveDrafts(DRAFTS); // no #kv — must not throw
    expect(session.drafts).toEqual(DRAFTS);
    session.dispose();
  });
});
