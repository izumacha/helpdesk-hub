import type { TicketStatus } from '@/generated/prisma';

// Source of truth for ticket status transitions. Mirrors `docs/requirements.md` §5
// including `Closed → Open`（再オープン）which is an explicit product requirement,
// not an oversight. Changing this table requires updating the requirements doc
// and `tests/ticket-status.test.ts` together.
const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  New: ['Open', 'WaitingForUser', 'InProgress', 'Resolved', 'Closed'],
  Open: ['InProgress', 'WaitingForUser', 'Escalated', 'Resolved', 'Closed'],
  WaitingForUser: ['Open', 'InProgress', 'Resolved', 'Closed'],
  InProgress: ['WaitingForUser', 'Escalated', 'Resolved', 'Closed'],
  Escalated: ['InProgress', 'Resolved', 'Closed'],
  Resolved: ['Open', 'Closed'],
  Closed: ['Open'],
};

export function isValidTransition(from: TicketStatus, to: TicketStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function getAllowedTransitions(from: TicketStatus): TicketStatus[] {
  return ALLOWED_TRANSITIONS[from];
}
