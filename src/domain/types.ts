/**
 * Provider-neutral domain types.
 *
 * These types are the public contract exposed by the data layer (`src/data/*`).
 * They must NOT import from `@/generated/prisma` or any adapter.
 * Adapter code maps its native row shapes into these types.
 */

export type Role = 'requester' | 'agent' | 'admin';

export type TicketStatus =
  | 'New'
  | 'Open'
  | 'WaitingForUser'
  | 'InProgress'
  | 'Escalated'
  | 'Resolved'
  | 'Closed';

export type Priority = 'Low' | 'Medium' | 'High';

export type HistoryField = 'status' | 'priority' | 'assignee' | 'escalation';

export type FaqStatus = 'Candidate' | 'Published' | 'Rejected';

export type NotificationType = 'assigned' | 'escalated' | 'commented' | 'statusChanged';

export interface UserSummary {
  id: string;
  name: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

export interface Ticket {
  id: string;
  title: string;
  body: string;
  status: TicketStatus;
  priority: Priority;
  createdAt: Date;
  updatedAt: Date;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  firstRespondedAt: Date | null;
  resolvedAt: Date | null;
  escalatedAt: Date | null;
  escalationReason: string | null;
  creatorId: string;
  assigneeId: string | null;
  categoryId: string | null;
}

export interface TicketWithRefs extends Ticket {
  creator: UserSummary;
  assignee: UserSummary | null;
  category: { id: string; name: string } | null;
}

export interface TicketComment {
  id: string;
  ticketId: string;
  authorId: string;
  body: string;
  createdAt: Date;
}

export interface TicketHistory {
  id: string;
  ticketId: string;
  changedById: string;
  field: HistoryField;
  oldValue: string | null;
  newValue: string | null;
  createdAt: Date;
}

export interface FaqCandidate {
  id: string;
  ticketId: string;
  createdById: string;
  question: string;
  answer: string;
  status: FaqStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Notification {
  id: string;
  userId: string;
  ticketId: string | null;
  type: NotificationType;
  message: string;
  read: boolean;
  createdAt: Date;
}
