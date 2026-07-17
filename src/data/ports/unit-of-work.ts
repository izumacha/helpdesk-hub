// 各リポジトリの契約 (port) を束ねて 1 セットとして扱うための型定義
import type { AttachmentRepository } from './attachment-repository';
import type { CategoryRepository } from './category-repository';
import type { EmailThreadRepository } from './email-thread-repository';
import type { FaqRepository } from './faq-repository';
import type { InvitationRepository } from './invitation-repository';
import type { LineConfigRepository } from './line-config-repository';
import type { LineLinkCodeRepository } from './line-link-code-repository';
import type { LineMessageRepository } from './line-message-repository';
import type { LocationRepository } from './location-repository';
import type { MagicLinkRepository } from './magic-link-repository';
import type { NotificationRepository } from './notification-repository';
import type { QuarantinedEmailRepository } from './quarantined-email-repository';
import type { SamlAssertionRepository } from './saml-assertion-repository';
import type { SettingsAuditLogRepository } from './settings-audit-log-repository';
import type { SignupTokenRepository } from './signup-token-repository';
import type { SsoConfigRepository } from './sso-config-repository';
import type { TenantRepository } from './tenant-repository';
import type { TicketCommentRepository } from './ticket-comment-repository';
import type { TicketHistoryRepository } from './ticket-history-repository';
import type { TicketRepository } from './ticket-repository';
import type { UserRepository } from './user-repository';

// アプリ全体で使うリポジトリ群 (全ポートをまとめた集合)
export interface Repos {
  tickets: TicketRepository; // チケット操作
  users: UserRepository; // ユーザー操作
  notifications: NotificationRepository; // 通知操作
  faq: FaqRepository; // FAQ 操作
  history: TicketHistoryRepository; // 履歴操作
  comments: TicketCommentRepository; // コメント操作
  categories: CategoryRepository; // カテゴリ操作
  tenants: TenantRepository; // テナント操作 (マルチテナント化)
  magicLinks: MagicLinkRepository; // マジックリンクトークン操作 (パスワードレス認証)
  signupTokens: SignupTokenRepository; // §7.1 フォローアップ: セルフサーブサインアップトークン操作
  invitations: InvitationRepository; // 招待リンクトークン操作 (メンバー招待)
  attachments: AttachmentRepository; // 添付ファイル (画像) のメタ情報操作
  emailThreads: EmailThreadRepository; // メール Message-ID → チケット 対応表 (スレッド継続 / Phase 2)
  lineMessages: LineMessageRepository; // LINE メッセージ ID → チケット 対応表 (取り込みの冪等化 / Phase 2)
  lineLinkCodes: LineLinkCodeRepository; // LINE 連携コード処理の冪等化記録 (Phase 2.1 フォローアップ)
  locations: LocationRepository; // Phase 4 多拠点: テナント内の店舗・拠点
  ssoConfigs: SsoConfigRepository; // Phase 4 Enterprise: テナント単位の SAML SSO 設定
  samlAssertions: SamlAssertionRepository; // Phase 4 Enterprise SSO フォローアップ: アサーションのリプレイ防止記録
  lineConfigs: LineConfigRepository; // Phase 2 フォローアップ: テナント単位の LINE 連携設定
  settingsAudit: SettingsAuditLogRepository; // §4.2 フォローアップ: 設定変更監査ログ
  quarantinedEmails: QuarantinedEmailRepository; // §3.2 フォローアップ: 隔離した受信メールの記録
}

// run() のオプション
export interface RunOptions {
  // 分離レベル。既定 (未指定) は DB の既定 (PostgreSQL は Read Committed)。
  // 「既存レコードが無ければ作る」形の冪等化 (Webhook 再送チェック) のように、
  // 同一キーに対する 2 トランザクションが競合し得る処理では 'Serializable' を指定する。
  // Read Committed では両トランザクションが「無い」という読み取りを通過してしまい
  // 二重作成につながるが、Serializable なら DB 側が競合を検知し、後勝ちのトランザクションを
  // 書き込み競合エラーで中断する (呼び出し側が catch して重複扱いにリトライする前提)。
  isolationLevel?: 'Serializable';
}

// トランザクション境界を表す契約 (Unit of Work パターン)
// run に渡した関数内ではトランザクション対応の Repos が使える
export interface UnitOfWork {
  run<T>(fn: (txRepos: Repos) => Promise<T>, options?: RunOptions): Promise<T>;

  // isolationLevel: 'Serializable' で実行した run() が、書き込み競合で中断された
  // ときの例外かどうかを判定する。DB 固有のエラー形状 (Prisma のエラーコード等) を
  // 呼び出し側 (Server Action / Route Handler) に漏らさないための判定ヘルパー。
  isTransactionConflict(err: unknown): boolean;
}
