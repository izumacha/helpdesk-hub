// Prisma が生成する型を参照するためにインポート
import type { Prisma } from '@/generated/prisma';
// ドメイン型 (アダプタが返すべき型) をインポート
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

// Prisma から取り出した User テーブルの型エイリアス (include なし)
type UserRow = Prisma.UserGetPayload<Record<string, never>>;
// Ticket テーブルの型エイリアス
type TicketRow = Prisma.TicketGetPayload<Record<string, never>>;
// 関連 (creator / assignee / category) を include した Ticket の型エイリアス
type TicketRowWithRefs = Prisma.TicketGetPayload<{
  include: {
    creator: { select: { id: true; name: true } };
    assignee: { select: { id: true; name: true } };
    category: { select: { id: true; name: true } };
  };
}>;
// Notification テーブルの型エイリアス
type NotificationRow = Prisma.NotificationGetPayload<Record<string, never>>;
// TicketComment テーブルの型エイリアス
type CommentRow = Prisma.TicketCommentGetPayload<Record<string, never>>;
// TicketHistory テーブルの型エイリアス
type HistoryRow = Prisma.TicketHistoryGetPayload<Record<string, never>>;
// FaqCandidate テーブルの型エイリアス
type FaqRow = Prisma.FaqCandidateGetPayload<Record<string, never>>;

// Prisma の User 行をドメイン型 User に変換する関数
export function toUser(row: UserRow): User {
  // 必要なフィールドだけを抜き出して返す (余計なフィールドは付与しない)
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

// 一覧表示等に使う最小情報 (id/name) を持つ UserSummary に変換する関数
export function toUserSummary(row: Pick<UserRow, 'id' | 'name'>): UserSummary {
  // id と name だけのオブジェクトを返す
  return { id: row.id, name: row.name };
}

// Prisma の Ticket 行をドメイン型 Ticket に変換する関数
export function toTicket(row: TicketRow): Ticket {
  // 必要なフィールドをそのまま詰め替えて返す
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

// 関連情報付きチケット行を TicketWithRefs に変換する関数
export function toTicketWithRefs(row: TicketRowWithRefs): TicketWithRefs {
  // 本体を toTicket で変換しつつ、creator/assignee/category を詰め替える
  return {
    ...toTicket(row),
    creator: toUserSummary(row.creator), // 起票者
    assignee: row.assignee ? toUserSummary(row.assignee) : null, // 担当者 (未アサインなら null)
    category: row.category ? { id: row.category.id, name: row.category.name } : null, // カテゴリ
  };
}

// Prisma の Notification 行をドメイン型 Notification に変換する関数
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

// Prisma の TicketComment 行をドメイン型 TicketComment に変換する関数
export function toComment(row: CommentRow): TicketComment {
  return {
    id: row.id,
    ticketId: row.ticketId,
    authorId: row.authorId,
    body: row.body,
    createdAt: row.createdAt,
  };
}

// Prisma の TicketHistory 行をドメイン型 TicketHistory に変換する関数
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

// Prisma の FaqCandidate 行をドメイン型 FaqCandidate に変換する関数
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
