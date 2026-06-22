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

// テナントの動作モード (Lite=SMB 既定 / Pro=現行フル機能)
export type TenantMode = 'lite' | 'pro';

// Phase 4 課金: サブスクリプションプラン
// Free: 3 名・月 50 件 / Standard: 10 名・Lite フル / Pro: 30 名・Pro モード /
// Enterprise: 個別見積・無制限・SSO(SAML)・監査強化 (smb-dx-pivot-plan.md §6.1)
export type SubscriptionPlan = 'free' | 'standard' | 'pro' | 'enterprise';

// テナント (組織) 本体。マルチテナントの境界を表す
export interface Tenant {
  id: string; // テナント ID (主キー)
  name: string; // 組織名 (画面表示用)
  mode: TenantMode; // Lite/Pro モード
  industry: string | null; // 業種テンプレ識別子 (未設定なら null)
  inboundToken: string | null; // メール取り込み用アドレスのローカルパート (未発行なら null)
  // Phase 4: 外部通知チャネル。Slack Incoming Webhook URL (null なら通知無効)
  slackWebhookUrl: string | null;
  // Phase 4: 外部通知チャネル。Microsoft Teams Incoming Webhook URL (null なら通知無効)
  teamsWebhookUrl: string | null;
  // Phase 4: 外部通知チャネル。Chatwork API トークン (null なら通知無効)
  chatworkApiToken: string | null;
  // Phase 4: 外部通知チャネル。投稿先の Chatwork ルーム ID (数字文字列。null なら通知無効)
  chatworkRoomId: string | null;
  // Phase 4 課金: Stripe Billing 連携フィールド
  subscriptionPlan: SubscriptionPlan; // 現在の課金プラン (既定: free)
  stripeCustomerId: string | null; // Stripe Customer ID (cu_xxx)
  stripeSubscriptionId: string | null; // Stripe Subscription ID (sub_xxx)
  stripeSubscriptionStatus: string | null; // Stripe の subscription.status 文字列
  createdAt: Date; // 作成日時
}

// Phase 4 多拠点: テナント内の店舗・拠点 1 件分
export interface Location {
  id: string; // 拠点 ID (主キー)
  tenantId: string; // 所属テナント ID
  name: string; // 拠点名 (例: 渋谷本店、第一工場)
  description: string | null; // 補足説明 (任意)
  createdAt: Date; // 作成日時
}

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
  tenantId: string; // 所属テナント ID (マルチテナント化のキー)
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
  locationId: string | null; // 拠点 ID (Phase 4 多拠点。未指定なら null)
  tenantId: string; // 所属テナント ID (マルチテナント化のキー)
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
  tenantId: string; // 所属テナント ID (マルチテナント化のキー)
}

// マジックリンク (パスワードレス認証) のワンタイムトークン 1 件分
// 生トークンは URL のみで保持し、DB には SHA-256 ハッシュ (tokenHash) を保存する
export interface MagicLinkToken {
  id: string; // トークン ID (主キー)
  email: string; // 送信先メール (小文字正規化済み)
  tokenHash: string; // 生トークンの SHA-256 ハッシュ
  expiresAt: Date; // 失効時刻 (発行 15 分後)
  consumedAt: Date | null; // 消費済み時刻。null なら未使用 (単回使用を強制)
  requestedIp: string | null; // 発行リクエスト元 IP (監査用)
  createdAt: Date; // 作成日時
}

// テナントへのメンバー招待リンク 1 件分
// 生トークンは URL のみで保持し、DB には SHA-256 ハッシュ (tokenHash) を保存する。
// 発行時点で参加先 (tenantId) と付与権限 (role) が確定しているのが MagicLinkToken との違い。
export interface Invitation {
  id: string; // 招待 ID (主キー)
  tokenHash: string; // 生トークンの SHA-256 ハッシュ
  email: string | null; // 宛先メール (任意。未指定ならリンク手渡し想定)
  role: Role; // 参加後に付与する権限 (requester=メンバー / agent=担当者)
  expiresAt: Date; // 失効時刻 (発行 7 日後)
  consumedAt: Date | null; // 受諾済み時刻。null なら未使用 (単回使用を強制)
  invitedById: string | null; // 発行した admin の User ID (監査用)
  tenantId: string; // 参加先テナント ID (受諾時はこの値でユーザーを作る = 入力から注入しない)
  createdAt: Date; // 作成日時
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
  tenantId: string; // 所属テナント ID (マルチテナント化のキー)
}
