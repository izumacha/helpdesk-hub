import { beforeEach, describe, expect, it } from 'vitest';

import { __resetRateLimits, enforceRateLimit } from '../src/lib/rate-limit';

describe('enforceRateLimit', () => {
  beforeEach(() => {
    __resetRateLimits();
  });

  it('allows calls up to the limit within the window', () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      expect(() => enforceRateLimit('k', { limit: 3, windowMs: 10_000 }, now + i)).not.toThrow();
    }
  });

  it('rejects the next call beyond the limit with a Japanese message', () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      enforceRateLimit('k', { limit: 3, windowMs: 10_000 }, now + i);
    }
    expect(() => enforceRateLimit('k', { limit: 3, windowMs: 10_000 }, now + 4)).toThrow(
      /操作の頻度/,
    );
  });

  it('allows calls again once the oldest entry ages out of the window', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      enforceRateLimit('k', { limit: 3, windowMs: 10_000 }, t0 + i);
    }
    // Jump just past the window relative to the first hit.
    expect(() => enforceRateLimit('k', { limit: 3, windowMs: 10_000 }, t0 + 10_001)).not.toThrow();
  });

  it('tracks keys independently', () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      enforceRateLimit('user-a', { limit: 3, windowMs: 10_000 }, now + i);
    }
    // Different key still has full budget.
    expect(() => enforceRateLimit('user-b', { limit: 3, windowMs: 10_000 }, now)).not.toThrow();
  });
});
