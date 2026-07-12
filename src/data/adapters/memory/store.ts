// ドメイン型をインポート (メモリストア内に保持するデータ型)
import type {
  FaqCandidate,
  Invitation,
  Location,
  MagicLinkToken,
  Notification,
  QuarantinedEmail,
  SettingsAuditLog,
  Tenant,
  TenantLineConfig,
  TenantSsoConfig,
  Ticket,
  TicketComment,
  TicketHistory,
  User,
} from '@/domain/types';
// 添付ファイルのドメイン型 (メモリストアで保持する用)
import type { Attachment } from '@/domain/attachment';

// メモリ内で保持するカテゴリ行 (id/name/作成日時 + テナント所属)
export interface CategoryRow {
  id: string; // カテゴリ ID
  name: string; // カテゴリ名
  createdAt: Date; // 作成日時
  tenantId: string; // 所属テナント ID (マルチテナント化のキー)
}

// メモリ内で保持するメールスレッド対応表の 1 行 (Message-ID → ticket / Phase 2)
export interface EmailThreadRefRow {
  id: string; // 行 ID
  messageId: string; // 正規化済み Message-ID
  ticketId: string; // 紐づくチケット ID
  tenantId: string; // 所属テナント ID (突き合わせスコープのキー)
  createdAt: Date; // 記録日時 (新しい紐付けを優先するため)
}

// メモリ内で保持する LINE メッセージ対応表の 1 行 (LINE メッセージ ID → ticket / Phase 2 冪等化)
export interface LineMessageRefRow {
  id: string; // 行 ID
  lineMessageId: string; // LINE メッセージ ID (Webhook イベントの message.id)
  ticketId: string; // 紐づくチケット ID
  tenantId: string; // 所属テナント ID (突き合わせスコープのキー)
  createdAt: Date; // 記録日時
}

// テスト用アダプタが使うインメモリストア。
// `idSeq` カウンタはストアごとに独立しているので、テストコンテキスト間で状態が混ざらず
// 連番 ID も安定して再現できる。
// テスト用メモリストアの型。エンティティごとに Map を持つ
export interface Store {
  tenants: Map<string, Tenant>; // テナント (マルチテナント化)
  users: Map<string, User>; // ユーザー
  categories: Map<string, CategoryRow>; // カテゴリ
  tickets: Map<string, Ticket>; // チケット
  comments: Map<string, TicketComment>; // コメント
  histories: Map<string, TicketHistory>; // 履歴
  faq: Map<string, FaqCandidate>; // FAQ 候補
  notifications: Map<string, Notification>; // 通知
  magicLinks: Map<string, MagicLinkToken>; // マジックリンクトークン (パスワードレス認証)
  invitations: Map<string, Invitation>; // 招待リンクトークン (メンバー招待)
  attachments: Map<string, Attachment>; // 添付ファイルのメタ情報 (画像)
  emailThreadRefs: Map<string, EmailThreadRefRow>; // メール Message-ID → チケット 対応表 (Phase 2)
  lineMessageRefs: Map<string, LineMessageRefRow>; // LINE メッセージ ID → チケット 対応表 (Phase 2 冪等化)
  // LINE 連携コード処理 (紐付け成功/競合) の冪等化記録。起票を伴わないため lineMessageRefs
  // の対象外になる連携コード処理の再送検出用 (§4 Phase 2.1 フォローアップ)。
  // messageId はプラットフォーム全体で一意なため Set のみで十分 (tenantId スコープ不要)
  lineLinkCodeRefs: Set<string>;
  locations: Map<string, Location>; // Phase 4 多拠点: テナント内の店舗・拠点
  ssoConfigs: Map<string, TenantSsoConfig>; // Phase 4 Enterprise: テナント単位の SAML SSO 設定
  lineConfigs: Map<string, TenantLineConfig>; // Phase 2 フォローアップ: テナント単位の LINE 連携設定
  settingsAuditLogs: Map<string, SettingsAuditLog>; // §4.2 フォローアップ: 設定変更監査ログ
  quarantinedEmails: Map<string, QuarantinedEmail>; // §3.2 フォローアップ: 隔離した受信メールの記録
  idSeq: { value: number }; // 連番生成用のカウンタ (オブジェクトに包んで参照共有)
}

// 空のストアを作って返すファクトリ関数
export function createEmptyStore(): Store {
  // 全エンティティを空の Map とし、連番を 0 から開始
  return {
    tenants: new Map(),
    users: new Map(),
    categories: new Map(),
    tickets: new Map(),
    comments: new Map(),
    histories: new Map(),
    faq: new Map(),
    notifications: new Map(),
    magicLinks: new Map(),
    invitations: new Map(),
    attachments: new Map(),
    emailThreadRefs: new Map(),
    lineMessageRefs: new Map(),
    lineLinkCodeRefs: new Set(),
    locations: new Map(), // Phase 4 多拠点: テナント内の店舗・拠点
    ssoConfigs: new Map(), // Phase 4 Enterprise: SAML SSO 設定
    lineConfigs: new Map(), // Phase 2 フォローアップ: テナント単位の LINE 連携設定
    settingsAuditLogs: new Map(), // §4.2 フォローアップ: 設定変更監査ログ
    quarantinedEmails: new Map(), // §3.2 フォローアップ: 隔離した受信メールの記録
    idSeq: { value: 0 },
  };
}

// ストアを浅くコピーする関数 (トランザクション擬似実装のスナップショット用)
export function cloneStore(src: Store): Store {
  // 各 Map を複製し、連番カウンタの値もコピー
  return {
    tenants: new Map(src.tenants),
    users: new Map(src.users),
    categories: new Map(src.categories),
    tickets: new Map(src.tickets),
    comments: new Map(src.comments),
    histories: new Map(src.histories),
    faq: new Map(src.faq),
    notifications: new Map(src.notifications),
    magicLinks: new Map(src.magicLinks),
    invitations: new Map(src.invitations),
    attachments: new Map(src.attachments),
    emailThreadRefs: new Map(src.emailThreadRefs),
    lineMessageRefs: new Map(src.lineMessageRefs),
    lineLinkCodeRefs: new Set(src.lineLinkCodeRefs),
    locations: new Map(src.locations), // Phase 4 多拠点
    ssoConfigs: new Map(src.ssoConfigs), // Phase 4 Enterprise: SAML SSO 設定
    lineConfigs: new Map(src.lineConfigs), // Phase 2 フォローアップ: テナント単位の LINE 連携設定
    settingsAuditLogs: new Map(src.settingsAuditLogs), // §4.2 フォローアップ: 設定変更監査ログ
    quarantinedEmails: new Map(src.quarantinedEmails), // §3.2 フォローアップ: 隔離した受信メールの記録
    idSeq: { value: src.idSeq.value },
  };
}

// dst の中身を src で上書きする関数 (ロールバック用)
export function overwriteStore(dst: Store, src: Store): void {
  // 各エンティティを src のコピーで置き換える
  dst.tenants = new Map(src.tenants);
  dst.users = new Map(src.users);
  dst.categories = new Map(src.categories);
  dst.tickets = new Map(src.tickets);
  dst.comments = new Map(src.comments);
  dst.histories = new Map(src.histories);
  dst.faq = new Map(src.faq);
  dst.notifications = new Map(src.notifications);
  dst.magicLinks = new Map(src.magicLinks);
  dst.invitations = new Map(src.invitations);
  dst.attachments = new Map(src.attachments);
  dst.emailThreadRefs = new Map(src.emailThreadRefs);
  dst.lineMessageRefs = new Map(src.lineMessageRefs);
  dst.lineLinkCodeRefs = new Set(src.lineLinkCodeRefs);
  dst.locations = new Map(src.locations); // Phase 4 多拠点
  dst.ssoConfigs = new Map(src.ssoConfigs); // Phase 4 Enterprise: SAML SSO 設定
  dst.lineConfigs = new Map(src.lineConfigs); // Phase 2 フォローアップ: テナント単位の LINE 連携設定
  dst.settingsAuditLogs = new Map(src.settingsAuditLogs); // §4.2 フォローアップ: 設定変更監査ログ
  dst.quarantinedEmails = new Map(src.quarantinedEmails); // §3.2 フォローアップ: 隔離した受信メールの記録
  // 連番も元に戻す
  dst.idSeq.value = src.idSeq.value;
}

/**
 * Per-store id generator. Not a real cuid — the contract test only requires
 * that ids are unique within a store.
 */
// ストア単位の ID 生成関数 (テスト内で一意であれば十分)
export function nextId(store: Store, prefix: string): string {
  // カウンタをインクリメント
  store.idSeq.value += 1;
  // prefix + 36 進カウンタ + ランダム文字列 で ID を構築して返す
  return `${prefix}_${store.idSeq.value.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
