/**
 * Smoke test: assert every engine module loads and its public surface exists.
 * Deep behavior lives in each module's own test file; this only guards the
 * barrel wiring and confirms the real implementations are live.
 */

import { describe, expect, it } from 'vitest';

import * as engine from '../src/index.js';
import { parseUnifiedDiff } from '../src/diff/parse.js';
import { ClaudeAgent } from '../src/agent/claude.js';
import { GhClient } from '../src/github/gh.js';
import { buildDigest, normalizeReview } from '../src/review/pipeline.js';
import { runProgressiveReview, buildFileReviewSchema } from '../src/review/progressive.js';
import { ReviewCache } from '../src/store/cache.js';

describe('engine public surface', () => {
  it('re-exports from the barrel', () => {
    expect(engine.parseUnifiedDiff).toBe(parseUnifiedDiff);
    expect(engine.ClaudeAgent).toBe(ClaudeAgent);
    expect(engine.GhClient).toBe(GhClient);
    expect(engine.buildDigest).toBe(buildDigest);
    expect(engine.normalizeReview).toBe(normalizeReview);
    expect(engine.runProgressiveReview).toBe(runProgressiveReview);
    expect(engine.ReviewCache).toBe(ReviewCache);
  });

  it('diff parser is defined', () => {
    expect(typeof parseUnifiedDiff).toBe('function');
  });

  it('claude agent exposes its methods', () => {
    const agent = new ClaudeAgent();
    expect(typeof agent.runStructured).toBe('function');
    expect(typeof agent.chatStream).toBe('function');
    expect(typeof agent.isAvailable).toBe('function');
  });

  it('gh client exposes its methods', () => {
    const gh = new GhClient();
    expect(typeof gh.prMeta).toBe('function');
    expect(typeof gh.prDiff).toBe('function');
    expect(typeof gh.prFiles).toBe('function');
    expect(typeof gh.fetchBlob).toBe('function');
    expect(typeof gh.submitReview).toBe('function');
  });

  it('review pipeline is defined', () => {
    expect(typeof buildDigest).toBe('function');
    expect(typeof normalizeReview).toBe('function');
    expect(typeof runProgressiveReview).toBe('function');
    expect(buildFileReviewSchema(1)).toHaveProperty('properties');
  });

  it('review cache exposes its methods', () => {
    const cache = new ReviewCache({ dir: '/tmp/argus-cache-smoke' });
    expect(typeof cache.hash).toBe('function');
    expect(typeof cache.get).toBe('function');
    expect(typeof cache.set).toBe('function');
  });

  it('real implementations are live (no not-implemented stubs)', () => {
    expect(parseUnifiedDiff('', 'sha')).toEqual([]);
  });
});
