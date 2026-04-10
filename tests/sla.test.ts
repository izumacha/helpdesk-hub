import { describe, expect, it } from 'vitest';
import { getSlaState } from '../src/lib/sla';

describe('getSlaState', () => {
  const now = new Date();
  const past = new Date(now.getTime() - 2 * 60 * 60 * 1000);         // 2h ago
  const soon = new Date(now.getTime() + 10 * 60 * 60 * 1000);        // 10h later
  const future = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);  // 3 days later

  it('returns "none" when no resolutionDueAt is set', () => {
    expect(getSlaState(null, null)).toBe('none');
  });

  it('returns "ok" when ticket is already resolved', () => {
    expect(getSlaState(past, now)).toBe('ok');
  });

  it('returns "overdue" when deadline has passed and not resolved', () => {
    expect(getSlaState(past, null)).toBe('overdue');
  });

  it('returns "warning" when deadline is within 24 hours and not resolved', () => {
    expect(getSlaState(soon, null)).toBe('warning');
  });

  it('returns "ok" when deadline is more than 24 hours away and not resolved', () => {
    expect(getSlaState(future, null)).toBe('ok');
  });
});
