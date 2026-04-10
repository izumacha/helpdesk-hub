export const TICKET_STATUSES = [
  'New',
  'Open',
  'Waiting for User',
  'In Progress',
  'Escalated',
  'Resolved',
  'Closed',
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const STATUS_TRANSITION_RULES: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  New: ['Open'],
  Open: ['In Progress'],
  'Waiting for User': [],
  'In Progress': ['Waiting for User', 'Escalated', 'Resolved'],
  Escalated: [],
  Resolved: ['Closed', 'Open'],
  Closed: [],
};

export class InvalidStatusTransitionError extends Error {
  constructor(from: TicketStatus, to: TicketStatus) {
    super(`Invalid status transition: ${from} -> ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}

export function getAvailableTransitions(from: TicketStatus): readonly TicketStatus[] {
  return STATUS_TRANSITION_RULES[from];
}

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return STATUS_TRANSITION_RULES[from].includes(to);
}

export function assertValidTransition(from: TicketStatus, to: TicketStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidStatusTransitionError(from, to);
  }
}
