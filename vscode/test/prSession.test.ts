import { describe, expect, it } from 'vitest';

import { PrSession } from '../src/prSession';

describe('PrSession.regenerate on a demo/fixture session', () => {
  it('is a no-op that preserves the fixture review (never wipes it into an error)', async () => {
    const session = await PrSession.loadDemo();
    expect(session.review).not.toBeNull();
    expect(session.reviewError).toBeNull();

    const reviewBefore = session.review;

    await session.regenerate();

    // Regenerate on a demo must not route through the "claude not found" branch
    // and must leave the fixture review intact (contract 19 stays satisfied).
    expect(session.review).toBe(reviewBefore);
    expect(session.reviewError).toBeNull();

    session.dispose();
  });
});
