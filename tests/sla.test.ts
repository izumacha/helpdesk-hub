import { describe, expect, it } from 'vitest';
import {
  calculateResolutionDueAt,
  getSlaState,
  SLA_RESOLUTION_HOURS_BY_PRIORITY,
} from '../src/lib/sla';

describe('calculateResolutionDueAt', () => {
  const base = new Date('2026-04-17T00:00:00Z');

  it('adds 24 hours for High priority', () => {
    const due = calculateResolutionDueAt('High', base);
    expect(due.getTime() - base.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('adds 72 hours for Medium priority', () => {
    const due = calculateResolutionDueAt('Medium', base);
    expect(due.getTime() - base.getTime()).toBe(72 * 60 * 60 * 1000);
  });

  it('adds 168 hours (7 days) for Low priority', () => {
    const due = calculateResolutionDueAt('Low', base);
    expect(due.getTime() - base.getTime()).toBe(168 * 60 * 60 * 1000);
  });

  it('exposes the hours table for each priority', () => {
    expect(SLA_RESOLUTION_HOURS_BY_PRIORITY.High).toBe(24);
    expect(SLA_RESOLUTION_HOURS_BY_PRIORITY.Medium).toBe(72);
    expect(SLA_RESOLUTION_HOURS_BY_PRIORITY.Low).toBe(168);
  });
});

describe('getSlaState', () => {
  const now = new Date();
  const past = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2h ago
  const soon = new Date(now.getTime() + 10 * 60 * 60 * 1000); // 10h later
  const future = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days later

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
