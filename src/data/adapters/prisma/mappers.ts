import type { Prisma } from '@/generated/prisma';
import type {
  Notification,
  FaqCandidate,
  Ticket,
  TicketComment,
  TicketHistory,
  TicketWithRefs,
  User,
  UserSummary,
} from '@/domain/types';

type UserRow = Prisma.UserGetPayload<Record<string, never>>;
type TicketRow = Prisma.TicketGetPayload<Record<string, never>>;
type TicketRowWithRefs = Prisma.TicketGetPayload<{
  include: {
    creator: { select: { id: true; name: true } };
    assignee: { select: { id: true; name: true } };
    category: { select: { id: true; name: true } };
  };
}>;
type NotificationRow = Prisma.NotificationGetPayload<Record<string, never>>;
type CommentRow = Prisma.TicketCommentGetPayload<Record<string, never>>;
type HistoryRow = Prisma.TicketHistoryGetPayload<Record<string, never>>;
type FaqRow = Prisma.FaqCandidateGetPayload<Record<string, never>>;

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.passwordHash,
    role: row.role,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toUserSummary(row: Pick<UserRow, 'id' | 'name'>): UserSummary {
  return { id: row.id, name: row.name };
}

export function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    priority: row.priority,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    firstResponseDueAt: row.firstResponseDueAt,
    resolutionDueAt: row.resolutionDueAt,
    firstRespondedAt: row.firstRespondedAt,
    resolvedAt: row.resolvedAt,
    escalatedAt: row.escalatedAt,
    escalationReason: row.escalationReason,
    creatorId: row.creatorId,
    assigneeId: row.assigneeId,
    categoryId: row.categoryId,
  };
}

export function toTicketWithRefs(row: TicketRowWithRefs): TicketWithRefs {
  return {
    ...toTicket(row),
    creator: toUserSummary(row.creator),
    assignee: row.assignee ? toUserSummary(row.assignee) : null,
    category: row.category ? { id: row.category.id, name: row.category.name } : null,
  };
}

export function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    userId: row.userId,
    ticketId: row.ticketId,
    type: row.type,
    message: row.message,
    read: row.read,
    createdAt: row.createdAt,
  };
}

export function toComment(row: CommentRow): TicketComment {
  return {
    id: row.id,
    ticketId: row.ticketId,
    authorId: row.authorId,
    body: row.body,
    createdAt: row.createdAt,
  };
}

export function toHistory(row: HistoryRow): TicketHistory {
  return {
    id: row.id,
    ticketId: row.ticketId,
    changedById: row.changedById,
    field: row.field,
    oldValue: row.oldValue,
    newValue: row.newValue,
    createdAt: row.createdAt,
  };
}

export function toFaq(row: FaqRow): FaqCandidate {
  return {
    id: row.id,
    ticketId: row.ticketId,
    createdById: row.createdById,
    question: row.question,
    answer: row.answer,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
