/**
 * Provider-neutral domain types.
 *
 * These types are the public contract exposed by the data layer (`src/data/*`).
 * They must NOT import from `@/generated/prisma` or any adapter.
 * Adapter code maps its native row shapes into these types.
 */

// ユーザーの権限区分 (依頼者 / 担当者 / 管理者)
export type Role = 'requester' | 'agent' | 'admin';

// チケットの状態 (新規/受付中/依頼者待ち/作業中/エスカレーション/解決/完了)
export type TicketStatus =
  | 'New'
  | 'Open'
  | 'WaitingForUser'
  | 'InProgress'
  | 'Escalated'
  | 'Resolved'
  | 'Closed';

// 優先度 (低/中/高)
export type Priority = 'Low' | 'Medium' | 'High';

// 履歴に記録する項目の種類 (状態/優先度/担当者/エスカレーション)
export type HistoryField = 'status' | 'priority' | 'assignee' | 'escalation';

// FAQ 候補の公開状態 (候補/公開中/却下)
export type FaqStatus = 'Candidate' | 'Published' | 'Rejected';

// ユーザー向け通知の種類 (担当割当/エスカレーション/コメント/状態変更)
export type NotificationType = 'assigned' | 'escalated' | 'commented' | 'statusChanged';

// 一覧表示などで最低限必要なユーザー情報だけを持つ軽量型
export interface UserSummary {
  id: string; // ユーザー ID
  name: string; // 画面に表示する氏名
}

// ユーザー本体。認証情報と基本属性を保持する
export interface User {
  id: string; // ユーザー ID (主キー)
  email: string; // ログイン用メールアドレス (一意)
  name: string; // 氏名
  passwordHash: string; // bcrypt でハッシュ化済みパスワード (平文は保存しない)
  role: Role; // 権限区分
  createdAt: Date; // 登録日時
  updatedAt: Date; // 最終更新日時
}

// チケット本体。問い合わせ 1 件に対応する中心データ
export interface Ticket {
  id: string; // チケット ID (主キー)
  title: string; // 件名
  body: string; // 本文 (問い合わせ内容)
  status: TicketStatus; // 現在の状態
  priority: Priority; // 優先度
  createdAt: Date; // 起票日時
  updatedAt: Date; // 最終更新日時
  firstResponseDueAt: Date | null; // 初回応答期限 (SLA)。未設定なら null
  resolutionDueAt: Date | null; // 解決期限 (SLA)。未設定なら null
  firstRespondedAt: Date | null; // 初回応答した日時。未応答なら null
  resolvedAt: Date | null; // 解決した日時。未解決なら null
  escalatedAt: Date | null; // エスカレーションした日時。していなければ null
  escalationReason: string | null; // エスカレーション理由のテキスト
  creatorId: string; // 起票者ユーザー ID
  assigneeId: string | null; // 担当者ユーザー ID (未アサインなら null)
  categoryId: string | null; // カテゴリ ID (未分類なら null)
}

// チケット本体に関連ユーザー/カテゴリを埋め込んだ拡張版 (画面表示用)
export interface TicketWithRefs extends Ticket {
  creator: UserSummary; // 起票者の概要
  assignee: UserSummary | null; // 担当者の概要 (未アサインなら null)
  category: { id: string; name: string } | null; // カテゴリ概要 (未分類なら null)
}

// チケットに付いたコメント 1 件分
export interface TicketComment {
  id: string; // コメント ID
  ticketId: string; // どのチケットに属すか
  authorId: string; // 書き込んだユーザー ID
  body: string; // コメント本文
  createdAt: Date; // 投稿日時
}

// チケットの変更履歴 1 件分
export interface TicketHistory {
  id: string; // 履歴 ID
  ticketId: string; // どのチケットの履歴か
  changedById: string; // 変更を行ったユーザー ID
  field: HistoryField; // どの項目が変更されたか
  oldValue: string | null; // 変更前の値 (初期登録時は null)
  newValue: string | null; // 変更後の値
  createdAt: Date; // 変更日時
}

// 解決済みチケットから派生した FAQ 候補 1 件分
export interface FaqCandidate {
  id: string; // FAQ 候補 ID
  ticketId: string; // 元となったチケット ID
  createdById: string; // 候補化したユーザー ID
  question: string; // 公開用の質問文
  answer: string; // 公開用の回答文
  status: FaqStatus; // 候補/公開/却下のいずれか
  createdAt: Date; // 候補化した日時
  updatedAt: Date; // 最終更新日時
}

// ユーザー向け通知 1 件分
export interface Notification {
  id: string; // 通知 ID
  userId: string; // 通知の受信者
  ticketId: string | null; // 関連チケット ID (ない場合は null)
  type: NotificationType; // 通知の種類
  message: string; // 表示する文言
  read: boolean; // 既読かどうか (true=既読, false=未読)
  createdAt: Date; // 通知の生成日時
}
