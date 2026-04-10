import type { TicketStatus } from '@/generated/prisma';

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
