// Prisma が生成する型を参照するためにインポート
import type { Prisma } from '@/generated/prisma';
// ドメイン型 (アダプタが返すべき型) をインポート
import type {
  Invitation,
  MagicLinkToken,
  Notification,
  FaqCandidate,
  SignupToken,
  Ticket,
  TicketComment,
  TicketHistory,
  TicketWithRefs,
  User,
  UserSummary,
} from '@/domain/types';
// 添付ファイル表示用のサマリ型
import type { AttachmentSummary } from '@/domain/attachment-summary';

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
    location: { select: { id: true; name: true } };
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
// MagicLinkToken テーブルの型エイリアス
type MagicLinkRow = Prisma.MagicLinkTokenGetPayload<Record<string, never>>;
// Invitation テーブルの型エイリアス
type InvitationRow = Prisma.InvitationGetPayload<Record<string, never>>;
// SignupToken テーブルの型エイリアス
type SignupTokenRow = Prisma.SignupTokenGetPayload<Record<string, never>>;
// Attachment テーブルの型エイリアス
type AttachmentRow = Prisma.AttachmentGetPayload<Record<string, never>>;

// Prisma の User 行をドメイン型 User に変換する関数
export function toUser(row: UserRow): User {
  // 必要なフィールドだけを抜き出して返す (余計なフィールドは付与しない)
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.passwordHash,
    role: row.role,
    tenantId: row.tenantId, // 所属テナント (マルチテナント化のキー)
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lineUserId: row.lineUserId, // LINE 紐付け先 (未連携なら null)
    lineLinkCodeHash: row.lineLinkCodeHash, // 発行中ワンタイムコードのハッシュ (なければ null)
    lineLinkCodeExpiresAt: row.lineLinkCodeExpiresAt, // 上記コードの失効時刻 (なければ null)
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
    slaReminderNotifiedForDueAt: row.slaReminderNotifiedForDueAt, // SLA 期限接近リマインダーの冪等化フラグ
    creatorId: row.creatorId,
    assigneeId: row.assigneeId,
    categoryId: row.categoryId,
    locationId: row.locationId, // 拠点 ID (Phase 4 多拠点。null なら未指定)
    tenantId: row.tenantId, // 所属テナント (マルチテナント化のキー)
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
    location: row.location ? { id: row.location.id, name: row.location.name } : null, // 拠点 (Phase 4 多拠点。未指定なら null)
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
    tenantId: row.tenantId, // 所属テナント (マルチテナント化のキー)
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

// Prisma の MagicLinkToken 行をドメイン型 MagicLinkToken に変換する関数
export function toMagicLinkToken(row: MagicLinkRow): MagicLinkToken {
  // 必要なフィールドだけを詰め替えて返す (生トークンは元から保存していないので無い)
  return {
    id: row.id,
    email: row.email,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    requestedIp: row.requestedIp,
    createdAt: row.createdAt,
    purpose: row.purpose, // login | ssoHandoff (Prisma enum の値をそのまま使う)
  };
}

// Prisma の SignupToken 行をドメイン型 SignupToken に変換する関数
export function toSignupToken(row: SignupTokenRow): SignupToken {
  // 必要なフィールドだけを詰め替えて返す (生トークンは元から保存していないので無い)
  return {
    id: row.id,
    email: row.email,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
  };
}

// Prisma の Invitation 行をドメイン型 Invitation に変換する関数
export function toInvitation(row: InvitationRow): Invitation {
  // 必要なフィールドだけを詰め替えて返す (生トークンは元から保存していないので無い)
  return {
    id: row.id,
    tokenHash: row.tokenHash,
    email: row.email,
    role: row.role,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    invitedById: row.invitedById,
    tenantId: row.tenantId, // 参加先テナント (受諾時の信頼の起点)
    createdAt: row.createdAt,
  };
}

// Prisma の Attachment 行を画面表示用の AttachmentSummary に変換する関数
// storageKey / uploaderId / tenantId など、画面で不要なフィールドは意図的に落とす
export function toAttachmentSummary(row: AttachmentRow): AttachmentSummary {
  return {
    id: row.id,
    mimeType: row.mimeType,
    size: row.size,
    originalName: row.originalName,
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
    tenantId: row.tenantId, // 所属テナント (マルチテナント化のキー)
  };
}
