import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PER_FILE_TIMEOUT_MS } from '@argus/engine';
import type {
  AgentResult,
  AgentRunOptions,
  ClaudeAgent,
  GhClient,
  IntentResult,
  JsonSchema,
  PullRequestMeta,
} from '@argus/engine';

import { PrSession } from '../src/prSession';

/**
 * The progressive review runs ONE call per file with a fixed per-file timeout;
 * a positive `argus.reviewTimeoutSeconds` overrides that per-file budget. These
 * tests capture the `timeoutMs` PrSession hands the agent for FILE calls (the
 * intent pass has its own fixed budget) and check the timeout error posture.
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

const INTENT: IntentResult = {
  summary: 'A summary.',
  intent: 'The intent.',
  critical: [],
  flow: [],
};

function isIntentSchema(schema: JsonSchema): boolean {
  return (
    Array.isArray((schema as { required?: string[] }).required) &&
    (schema as { required: string[] }).required.includes('summary')
  );
}

function filePayload(schema: JsonSchema): unknown {
  const n =
    (schema as { properties: { hunks: { minItems?: number } } }).properties.hunks
      .minItems ?? 0;
  return {
    role: 'core',
    note: 'n',
    bucket: 'Core logic',
    hunks: Array.from({ length: n }, (_, i) => ({
      hunkId: `h${i + 1}`,
      why: 'Exists for the change.',
      lookout: 'Verify behavior.',
      importance: 'normal',
    })),
  };
}

function ghStub(): GhClient {
  return {
    isAvailable: async () => true,
    isAuthed: async () => true,
    prMeta: async () => META,
    prDiff: async () => DIFF,
  } as unknown as GhClient;
}

/** Agent that records the `timeoutMs` of every FILE call, then succeeds. */
function capturingAgent(): {
  agent: ClaudeAgent;
  captured: () => number | undefined;
} {
  let seen: number | undefined;
  const agent = {
    isAvailable: async () => true,
    runStructured: async (
      _prompt: string,
      schema: JsonSchema,
      opts?: AgentRunOptions,
    ) => {
      if (isIntentSchema(schema)) {
        return { data: INTENT, model: 'm', raw: '{}' } satisfies AgentResult<IntentResult>;
      }
      seen = opts?.timeoutMs;
      return { data: filePayload(schema), model: 'm', raw: '{}' } as AgentResult<unknown>;
    },
  } as unknown as ClaudeAgent;
  return { agent, captured: () => seen };
}

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'argus-timeout-'));
}

describe('PrSession threads the per-file review timeout into the agent', () => {
  it('uses the fixed per-file default when the setting is unset', async () => {
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

    expect(captured()).toBe(PER_FILE_TIMEOUT_MS);

    session.dispose();
  });

  it('lets a positive setting override the per-file timeout', async () => {
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

  it('turns an all-files timeout into an actionable error (setting + regenerate)', async () => {
    const agent = {
      isAvailable: async () => true,
      runStructured: async () => {
        throw new Error('Claude Code timed out after 120s. No output was received from the CLI.');
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

  it('maps a not-logged-in failure to the /login call to action', async () => {
    const agent = {
      isAvailable: async () => true,
      runStructured: async () => {
        throw new Error('API error: authentication_error — please run /login');
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
    expect(session.reviewError ?? '').toMatch(/not logged in/i);
    expect(session.reviewError ?? '').toContain('/login');

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
    expect(captured()).toBe(PER_FILE_TIMEOUT_MS);

    // User raises the setting, then regenerates — the new value must be used.
    configured = 600;
    await session.regenerate();
    expect(captured()).toBe(600_000);

    session.dispose();
  });
});
