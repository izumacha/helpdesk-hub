import { describe, expect, it } from 'vitest';

import { getAllowedTransitions, isValidTransition } from '../src/domain/ticket-status';

describe('ticket status transition rules', () => {
  it('allows valid transitions from InProgress', () => {
    const allowed = getAllowedTransitions('InProgress');
    expect(allowed).toContain('WaitingForUser');
    expect(allowed).toContain('Escalated');
    expect(allowed).toContain('Resolved');
    expect(isValidTransition('InProgress', 'Resolved')).toBe(true);
    expect(isValidTransition('InProgress', 'Escalated')).toBe(true);
  });

  it('allows reopening from Resolved to Open', () => {
    expect(isValidTransition('Resolved', 'Open')).toBe(true);
  });

  it('allows reopening Closed ticket to Open', () => {
    expect(isValidTransition('Closed', 'Open')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(isValidTransition('Closed', 'InProgress')).toBe(false);
    expect(isValidTransition('Escalated', 'New')).toBe(false);
  });

  it('returns empty array for Closed (except Open)', () => {
    const allowed = getAllowedTransitions('Closed');
    expect(allowed).toEqual(['Open']);
  });
});
