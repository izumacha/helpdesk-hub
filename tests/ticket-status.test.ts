import { describe, expect, it } from 'vitest';

import {
  assertValidTransition,
  canTransition,
  getAvailableTransitions,
  InvalidStatusTransitionError,
  TICKET_STATUSES,
} from '../src/domain/ticket-status';

describe('ticket status transition rules', () => {
  it('supports only defined statuses', () => {
    expect(TICKET_STATUSES).toEqual([
      'New',
      'Open',
      'Waiting for User',
      'In Progress',
      'Escalated',
      'Resolved',
      'Closed',
    ]);
  });

  it('allows valid transitions from In Progress', () => {
    expect(getAvailableTransitions('In Progress')).toEqual([
      'Waiting for User',
      'Escalated',
      'Resolved',
    ]);

    expect(canTransition('In Progress', 'Resolved')).toBe(true);
    expect(canTransition('In Progress', 'Escalated')).toBe(true);
  });

  it('allows reopening from Resolved to Open', () => {
    expect(canTransition('Resolved', 'Open')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(canTransition('Open', 'Resolved')).toBe(false);

    expect(() => assertValidTransition('Open', 'Resolved')).toThrowError(
      InvalidStatusTransitionError,
    );
  });
});
