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

// 履歴に記録する項目の種類 (状態/優先度/担当者/エスカレーション/カテゴリ/拠点)
// フォローアップ (2026-07-14 #4): category/location はメール/LINE 取り込みチケットの
// 事後変更 (updateTicketCategory / updateTicketLocation) を可能にした際に追加した
export type HistoryField =
  | 'status'
  | 'priority'
  | 'assignee'
  | 'escalation'
  | 'category'
  | 'location';

// 設定変更監査ログの対象アクション種別 (SSO/LINE 連携/通知チャネル設定の変更)。
// prisma/schema.prisma の SettingsAuditAction enum および src/lib/constants.ts の
// SETTINGS_AUDIT_ACTION_LABELS と常に同期すること。値を追加したら 3 箇所すべてを更新する。
export type SettingsAuditAction =
  | 'sso_config_update' // SSO 設定の作成・更新
  | 'sso_config_delete' // SSO 設定の削除
  | 'line_config_update' // LINE 連携設定の作成・更新
  | 'line_config_delete' // LINE 連携設定の削除
  | 'notification_channels_update' // 通知チャネル設定の更新
  // §4.3 フォローアップ: SSO/LINE/通知チャネルと同じ「管理者による設定変更」でありながら
  // 監査対象から漏れていた操作
  | 'tenant_mode_update' // テナントの Lite/Pro モード切替
  | 'location_create' // 拠点の新規作成
  | 'location_update' // 拠点の更新
  | 'location_delete' // 拠点の削除
  | 'inbound_token_regenerate' // メール取り込み用転送先アドレスの (再)発行
  // フォローアップ (2026-07-11): SSO/LINE/通知チャネル設定と同じ「管理者による設定変更」でありながら
  // 監査対象から漏れていた操作。招待リンク発行 (特に agent 権限付与) は新しい人物に社内の全チケットへ
  // アクセスできる権限を与える操作であり、SSO 証明書変更等と同等以上にセキュリティ上重要
  | 'invitation_issue' // メンバー招待リンクの発行 (単発・一括まとめて 1 回)
  // フォローアップ (2026-07-13): Stripe 起因のプラン変更 (アップグレード/ダウングレード/解約) は
  // §4.4 の tenant_mode_update (Pro モード強制解除の副作用のときのみ記録) では捕捉されず、
  // subscriptionPlan 自体の変更は一度も監査対象になっていなかった
  | 'subscription_plan_update' // サブスクリプションプランの変更 (Stripe Webhook 起因)
  // フォローアップ (2026-07-14 #2): テナント作成は §4.5 の invitation_issue (agent 権限付与) と
  // 同種の「新しい権限を付与する操作」であり、それより強い admin 権限そのものを付与する操作
  // にもかかわらず監査対象から漏れていた
  | 'tenant_create'; // テナント + 初代管理者の作成 (運用者による作成 / セルフサーブサインアップ)

// メール/LINE 取り込みが起票せず隔離した理由。
// prisma/schema.prisma の QuarantineReason enum および src/lib/constants.ts の
// QUARANTINE_REASON_LABELS と常に同期すること。値を追加したら 3 箇所すべてを更新する。
// フォローアップ (2026-07-13): LINE 取り込みも同じ隔離記録テーブルを共有するようにしたため
// no_agents (LINE 専用) を追加した
export type QuarantineReason =
  | 'plan_gate' // 取り込みが契約プランで許可されていない (メール/LINE 共通)
  | 'auth_fail' // 送信元ドメイン認証 (SPF/DKIM/DMARC) が enforce ポリシーで明示 fail (メール専用)
  | 'unknown_sender' // 宛先テナントに所属しない送信者 (メール専用)
  | 'thread_forbidden' // 既知メンバーだが他人のチケットへの追記権限がない (メール専用)
  | 'quota_exceeded' // 月間チケット上限に到達済み (メール/LINE 共通)
  | 'no_agents'; // テナントに担当者が 1 人もおらず代理起票者を決められない (LINE 専用)

// 隔離記録の発生元チャネル。フォローアップ (2026-07-13): QuarantinedEmail をメール専用から
// チャネル共通の隔離記録へ拡張する際に追加した
export type QuarantineChannel = 'email' | 'line';

// 隔離した受信メール/LINE メッセージの記録 1 件分 (DB/メモリストアが保持する完全な形。
// tenantId を含む)。メール専用フィールド (senderAddress/senderName/subject) と LINE 専用
// フィールド (lineUserId) はどちらも channel に応じて片方だけが埋まる (もう片方は null)
export interface QuarantinedEmail {
  id: string; // 隔離記録 ID
  tenantId: string; // 対象テナント
  channel: QuarantineChannel; // 隔離記録の発生元チャネル
  reason: QuarantineReason; // 隔離した理由
  senderAddress: string | null; // 送信元メールアドレス (メール専用。LINE 記録では null)
  senderName: string | null; // 送信者名 (ヘッダから取れた場合のみ。メール専用)
  lineUserId: string | null; // LINE ユーザー ID (LINE 専用。メール記録では null)
  subject: string | null; // 件名 (メール専用。LINE 記録では null)
  createdAt: Date; // 隔離した日時
}

// 隔離した受信メール/LINE メッセージ 1 件分 (§3.2 フォローアップ: admin 向け一覧画面が表示する行。
// 呼び出し側は既にテナントスコープで絞り込み済みのため tenantId を含まない)
export type QuarantinedEmailRow = Omit<QuarantinedEmail, 'tenantId'>;

// Phase 4 外部通知チャネルの識別キー (Tenant.<channel>WebhookUrl 等・
// <channel>LastFailureAt/Message 列に対応)。src/data/ports/tenant-repository.ts
// (recordOutboundChannelResult) と src/lib/outbound-notify.ts の唯一の参照元。
// 値を追加したら両アダプタの switch (tenant-repository.{prisma,memory}.ts) と
// outbound-notify.ts の channelHasRecordedFailure・settings 画面も更新すること
export type OutboundChannelKey = 'slack' | 'teams' | 'chatwork';

// FAQ 候補の公開状態 (候補/公開中/却下)
export type FaqStatus = 'Candidate' | 'Published' | 'Rejected';

// ユーザー向け通知の種類 (担当割当/エスカレーション/コメント/状態変更/一括取り込み)
// prisma/schema.prisma の NotificationType enum および src/lib/constants.ts の
// NOTIFICATION_TYPE_LABELS と常に同期すること。値を追加したら 3 箇所すべてを更新する。
export type NotificationType =
  | 'assigned' // 担当割当通知
  | 'escalated' // エスカレーション通知
  | 'commented' // コメント追加通知
  | 'statusChanged' // ステータス変更通知
  | 'priorityChanged' // 優先度変更通知
  | 'imported' // CSV・メール一括取り込みで複数チケットが追加された通知
  | 'slaDueSoon'; // issue-backlog #20 フォローアップ: SLA 解決期限が近い (警告帯) ことの通知

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
  // 外部通知チャネルの直近送信失敗 (履歴は持たず直近 1 件のみ。成功したら null に戻る)。
  // 既存フィクスチャ・呼び出しを壊さないよう任意 (optional) とし、アダプタは常に null か値で埋める
  // (trialReminderLastSentDaysBefore と同じパターン)
  slackLastFailureAt?: Date | null;
  slackLastFailureMessage?: string | null;
  teamsLastFailureAt?: Date | null;
  teamsLastFailureMessage?: string | null;
  chatworkLastFailureAt?: Date | null;
  chatworkLastFailureMessage?: string | null;
  // Phase 4 課金: Stripe Billing 連携フィールド
  subscriptionPlan: SubscriptionPlan; // 現在の課金プラン (既定: free)
  stripeCustomerId: string | null; // Stripe Customer ID (cu_xxx)
  stripeSubscriptionId: string | null; // Stripe Subscription ID (sub_xxx)
  stripeSubscriptionStatus: string | null; // Stripe の subscription.status 文字列
  // §7.2「30日間の Free trial (Standard 相当)」。トライアル終了日時 (対象外/終了済みなら null)。
  // resolveEffectivePlan() がこの期限内だけ Standard 相当としてゲート判定する
  trialEndsAt: Date | null;
  // §7.2.1 Free trial 終了リマインダーの冪等化フラグ (直近に送信済みのマイルストーン。未送信は null)。
  // 既存フィクスチャ・呼び出しを壊さないよう任意 (optional) とし、アダプタは常に null か値で埋める
  // (User.lineUserId と同じパターン)
  trialReminderLastSentDaysBefore?: number | null;
  createdAt: Date; // 作成日時
}

// Phase 4 Enterprise: テナント単位の SAML SSO 設定 1 件分。
// アプリ (SP) が IdP からの受信アサーション署名を検証するために必要な情報を保持する。
export interface TenantSsoConfig {
  id: string; // 設定 ID (主キー)
  tenantId: string; // 所属テナント ID (1 テナント 1 設定)
  enabled: boolean; // SSO ログインを有効化するか (false なら無効 = fail-closed)
  idpEntityId: string; // IdP の EntityID (= 受信アサーションの Issuer。一致必須)
  idpSsoUrl: string; // IdP の SSO エンドポイント URL (AuthnRequest 送信先)
  idpX509Cert: string; // IdP の署名検証用 X.509 証明書 (PEM またはその base64 本体)
  createdAt: Date; // 作成日時
  updatedAt: Date; // 更新日時
}

// Phase 2 フォローアップ: テナント単位の LINE 公式アカウント連携設定 1 件分。
// docs/smb-dx-pivot-plan.md §4 Phase 2.1。Webhook 署名検証・Messaging API push の認証情報を保持する。
export interface TenantLineConfig {
  id: string; // 設定 ID (主キー)
  tenantId: string; // 所属テナント ID (1 テナント 1 設定)
  channelSecret: string; // Webhook 署名 (X-Line-Signature) の HMAC-SHA256 検証用シークレット
  channelAccessToken: string; // Messaging API push (担当者の返信を LINE へ返す) 用の長期アクセストークン
  botUserId: string; // LINE の destination フィールドと一致するこのチャネルの Bot User ID (テナント解決キー)
  createdAt: Date; // 作成日時
  updatedAt: Date; // 更新日時
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
  // LINE メンバー紐付け (Phase 2 β 解消)。確定リンク先 LINE ユーザー ID (未連携なら null)。
  // 既存のフィクスチャ・呼び出しを壊さないよう任意 (optional) とし、アダプタは常に null か値で埋める。
  lineUserId?: string | null;
  // 発行中ワンタイムコードの SHA-256 ハッシュ (生コードは保存しない。発行中でなければ null)。
  // ハッシュであり秘密そのものではないが、セッションには載せない (auth.ts は id/role/tenantId のみ転写)。
  lineLinkCodeHash?: string | null;
  // 上記コードの失効時刻 (発行中でなければ null)
  lineLinkCodeExpiresAt?: Date | null;
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
  // issue-backlog #20 フォローアップ: SLA 期限接近リマインダーの冪等化フラグ。
  // 「どの resolutionDueAt に対して通知済みか」を保持する (未通知/対象外なら null)
  slaReminderNotifiedForDueAt: Date | null;
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
  location: { id: string; name: string } | null; // 拠点概要 (Phase 4 多拠点。未指定なら null)
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

// 設定変更 (SSO/LINE 連携/通知チャネル) の監査ログ 1 件分。
// TicketHistory と異なり oldValue/newValue は持たない (秘匿情報を含む設定値のため記録しない)
export interface SettingsAuditLog {
  id: string; // 監査ログ ID
  tenantId: string; // 対象テナント
  // 操作を行ったユーザー ID。§4.3 フォローアップ (2026-07-10): Stripe Webhook 起因の
  // 自動プランダウングレードのようにユーザーが介在しないシステム操作を表現するため null を許容する
  actorId: string | null;
  action: SettingsAuditAction; // 実行された操作の種別
  createdAt: Date; // 操作日時
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

// マジックリンクトークンの用途。同じ MagicLinkToken テーブルを、通常のログイン用マジックリンク
// (login) と SAML SSO ACS のセッション引き渡し (ssoHandoff、src/app/api/auth/sso/<tenantId>/
// acs/route.ts が発行) の両方が共有しているため、レート制限件数 (countRecentByEmail) や
// 再送時の旧トークン失効 (invalidateActiveByEmail) を「通常のログイン用マジックリンク」だけに
// 限定するための判別子として使う (監査で発見したギャップ対応: 追加当初はこの区別が無く、
// requestMagicLink/requestSignup の呼び出しが進行中の SSO ログインの引き渡しトークンまで
// 巻き込んで失効させてしまっていた)。
export type MagicLinkPurpose = 'login' | 'ssoHandoff';

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
  purpose: MagicLinkPurpose; // この行の用途 (login | ssoHandoff)
}

// セルフサーブサインアップ (docs/smb-dx-pivot-plan.md §7.1) のワンタイムトークン 1 件分。
// MagicLinkToken と構造は同じだが、既存ユーザーの「ログイン」ではなくテナント/管理者を
// 新規作成する「サインアップ完了」用に発行される (常にまだ存在しないメール宛)
export interface SignupToken {
  id: string; // トークン ID (主キー)
  email: string; // サインアップ希望メール (小文字正規化済み)
  tokenHash: string; // 生トークンの SHA-256 ハッシュ
  expiresAt: Date; // 失効時刻 (発行 15 分後)
  consumedAt: Date | null; // サインアップ完了済み時刻。null なら未使用 (単回使用を強制)
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
