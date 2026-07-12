// チケット状態型・テナントモード型 (lite | pro)・権限型・設定監査アクション型を
// 正準のドメイン型から 1 本でインポート
import type {
  TicketStatus,
  TenantMode,
  Role,
  SettingsAuditAction,
  QuarantineReason,
} from '@/domain/types';
// Lite モードの 3 値型と型ガード関数を取り込み、mode-aware ラベル関数で使う
import { isLiteStatus, type LiteStatus } from '@/domain/ticket-status';

// チケット状態の英語キーに対応する日本語表示ラベル (Pro モード、現行 7 値)。
// /code-review ultra 指摘対応 (2026-07-10): Record<string, string> のままだと
// TicketStatus (domain/types.ts) にキーを追加/変更してもコンパイラが検知できず、
// resolveStatusFromLabel の as TicketStatus キャストが無効な文字列を作りかねなかった。
// TicketStatus をキー型にすることで、両者の食い違いをコンパイル時に検出できるようにする
export const STATUS_LABELS: Record<TicketStatus, string> = {
  New: '新規',
  Open: 'オープン',
  WaitingForUser: 'ユーザー待ち',
  InProgress: '対応中',
  Escalated: 'エスカレーション',
  Resolved: '解決済み',
  Closed: 'クローズ',
};

// Lite モード用の状態ラベル (Pivot plan §3.1 の用語表に基づきカタカナ・英語を排除)
// Lite テナントは UI 上で「未対応 / 対応中 / 完了」だけを使う
export const LITE_STATUS_LABELS: Record<LiteStatus, string> = {
  Open: '未対応', // 受付済みだがまだ着手していない (Lite では「未対応」と呼ぶ)
  InProgress: '対応中', // 担当者が作業中
  Closed: '完了', // 対応が終わった状態
};

// テナントモードに応じて状態ラベルを返す mode-aware 関数
// - mode === 'lite': まず LITE_STATUS_LABELS を引く。Lite 用 3 値以外 (例: 旧データの
//   Escalated / Resolved 等) が来た場合は Pro ラベルにフォールバックして安全に表示する
//   (テナントを Pro → Lite に切り替えた直後のエッジケース防御)
// - mode === 'pro': 既存どおり STATUS_LABELS をそのまま返す
export function getStatusLabel(status: TicketStatus, mode: TenantMode): string {
  // Lite モードかつ Lite 対応の 3 値なら Lite ラベルを返す (型ガードで LiteStatus に narrow)
  if (mode === 'lite' && isLiteStatus(status)) {
    return LITE_STATUS_LABELS[status];
  }
  // それ以外 (Pro モード or Lite で非対応ステータス) は Pro ラベルにフォールバック
  // 未知のキーは status 文字列をそのまま返して画面が空にならないようにする
  return STATUS_LABELS[status] ?? status;
}

// §3.1 フォローアップ (2026-07-10): getStatusLabel の逆写像。CSV インポート (import-tickets.ts) が
// 「状況」列の日本語ラベル (例: Lite の「完了」、Pro の「解決済み」) から TicketStatus を
// 逆引きするために使う。テナントの現在モードで表示されているラベル集合からのみ一致させる
// (Lite テナントに Pro 専用ラベルを渡しても一致させない。表示と入力の対称性を保つ)。
// 一致しなければ null を返し、呼び出し側が「値が不正」としてエラー行に記録する。
export function resolveStatusFromLabel(label: string, mode: TenantMode): TicketStatus | null {
  // mode に応じて検索対象のラベル集合を選ぶ (getStatusLabel と同じ mode-aware な切替)
  const labels: Record<string, string> = mode === 'lite' ? LITE_STATUS_LABELS : STATUS_LABELS;
  // ラベル集合を順に見て、値が一致するキー (TicketStatus) を返す
  for (const [status, statusLabel] of Object.entries(labels)) {
    if (statusLabel === label) return status as TicketStatus;
  }
  // 一致するラベルが無ければ null (未知の値)
  return null;
}

// §3.1 フォローアップ (2026-07-10): 指定モードで有効な状況ラベル一覧を返す。
// CSV インポートで「状況」列の値が resolveStatusFromLabel で解決できなかったとき、
// エラーメッセージに「入力できる値」を具体的に示すために使う。
export function getStatusLabelsForMode(mode: TenantMode): string[] {
  // mode に応じて Lite/Pro のラベル集合を選び、値 (日本語ラベル) の一覧を返す
  const labels = Object.values(mode === 'lite' ? LITE_STATUS_LABELS : STATUS_LABELS);
  // /code-review ultra 指摘対応 (2026-07-10): 「エスカレーション」は resolveStatusFromLabel
  // 自体は解決できるが、import-tickets.ts の validateImportRow が別のエラーメッセージで
  // 明示的に拒否する CSV インポート非対応の値。この一覧をそのままエラーヒントに出すと、
  // 「エスカレーションと指定してください」と案内した直後に矛盾する拒否メッセージを見せて
  // しまうため、CSV インポートで実際に指定できる値だけに絞る
  return labels.filter((label) => label !== STATUS_LABELS.Escalated);
}

// テナントの動作モード (lite | pro) の一覧。設定画面の選択肢生成や反復に使う
// (順序は UI の表示順。lite を既定として先頭に置く)
export const TENANT_MODES: readonly TenantMode[] = ['lite', 'pro'];

// テナントモードの日本語表示ラベル (設定画面の見出し・現在値表示に使う)
export const TENANT_MODE_LABELS: Record<TenantMode, string> = {
  lite: 'かんたんモード（Lite）', // SMB 向けの簡易モード
  pro: '詳細モード（Pro）', // 情シス向けのフル機能モード
};

// テナントモードの説明文 (設定画面で各モードの違いを利用者に伝える)
export const TENANT_MODE_DESCRIPTIONS: Record<TenantMode, string> = {
  // Lite: ステータスを 3 つに絞り、用語をやさしくした中小企業向けモード
  lite: 'ステータスを「未対応 / 対応中 / 完了」の3つに絞り、用語をやさしくした中小企業向けのモードです。エスカレーションや詳細なSLAは表示しません。',
  // Pro: 7 ステータス・SLA・エスカレーション・FAQ 候補などフル機能を有効化
  pro: '7つのステータス・SLA期限・エスカレーション・FAQ候補など、情シス向けのすべての機能を有効にします。',
};

// 権限 (Role) の日本語表示ラベル (Pivot plan §3.1 の用語表に基づく)。
// admin も組織管理者は「対応する人」なので担当者扱いの語彙に寄せる (UI ではロール 2 種に簡素化)。
export const ROLE_LABELS: Record<Role, string> = {
  requester: 'メンバー', // 問い合わせを出す人 (依頼者)
  agent: '担当者', // 問い合わせに対応する人
  admin: '管理者', // 組織の管理者 (担当者 + 設定権限)
};

// 招待リンクで付与できる権限の一覧 (招待画面の選択肢に使う)。
// admin は招待リンク経由では付与しない (管理者は別途テナント作成フォームで登録する想定)。
export const INVITABLE_ROLES: readonly Role[] = ['requester', 'agent'];

// 優先度キーに対応する日本語表示ラベル
export const PRIORITY_LABELS: Record<string, string> = {
  Low: '低',
  Medium: '中',
  High: '高',
};

// 状態ごとのバッジ配色 (Tailwind CSS クラス) ─ 健診/医療系の柔らかな soft chip
export const STATUS_COLORS: Record<string, string> = {
  New: 'bg-slate-100 text-slate-700 ring-1 ring-slate-200', // 新規: ニュートラルグレー
  Open: 'bg-teal-50 text-teal-800 ring-1 ring-teal-200', // オープン: ブランドティール
  WaitingForUser: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200', // ユーザー待ち: アンバー
  InProgress: 'bg-sky-50 text-sky-800 ring-1 ring-sky-200', // 対応中: スカイブルー
  Escalated: 'bg-rose-50 text-rose-800 ring-1 ring-rose-200', // エスカレーション: ロゼ
  Resolved: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200', // 解決済み: ミントグリーン
  Closed: 'bg-slate-50 text-slate-500 ring-1 ring-slate-200', // クローズ: 薄いグレー
};

// 優先度ごとの文字色クラス (Tailwind CSS) ─ 視認性を保ちつつ過剰な強さを抑える
export const PRIORITY_COLORS: Record<string, string> = {
  Low: 'text-slate-500', // 低: グレー
  Medium: 'text-amber-700', // 中: 落ち着いたアンバー
  High: 'text-rose-700 font-semibold', // 高: ロゼ + 太字
};

// 「FAQ 候補」機能そのものの呼称を mode に応じて切り替えるラベル (Pivot plan §3.1 用語表)。
// Lite ではカタカナ・英語を避けた「よくある質問」、Pro では従来どおり「FAQ候補」。
// ナビゲーション・一覧見出し・チケット詳細の登録導線など、この機能を指す箇所は
// すべてここを参照する (§6 一元管理)。
export const FAQ_TERM_LABELS: Record<TenantMode, string> = {
  lite: 'よくある質問',
  pro: 'FAQ候補',
};

// FAQ 状態キーに対応する日本語表示ラベル
export const FAQ_STATUS_LABELS: Record<string, string> = {
  Candidate: '候補',
  Published: '公開済み',
  Rejected: '却下',
};

// FAQ 状態ごとのバッジ配色 (Tailwind CSS クラス) ─ ステータスバッジと同方針
export const FAQ_STATUS_COLORS: Record<string, string> = {
  Candidate: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200', // 候補: アンバー
  Published: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200', // 公開済み: ミントグリーン
  Rejected: 'bg-slate-50 text-slate-500 ring-1 ring-slate-200', // 却下: 薄いグレー
};

// 履歴項目の英語キーに対応する日本語表示ラベル
export const HISTORY_FIELD_LABELS: Record<string, string> = {
  status: 'ステータス',
  priority: '優先度',
  assignee: '担当者',
  escalation: 'エスカレーション',
};

// 設定変更監査ログのアクション種別に対応する日本語表示ラベル。
// SettingsAuditAction 型 (src/domain/types.ts) / SettingsAuditAction enum (prisma/schema.prisma)
// に値を追加したらここも更新する (§4.2 フォローアップ)
export const SETTINGS_AUDIT_ACTION_LABELS: Record<SettingsAuditAction, string> = {
  sso_config_update: 'SSO 設定を更新',
  sso_config_delete: 'SSO 設定を削除',
  line_config_update: 'LINE 連携設定を更新',
  line_config_delete: 'LINE 連携設定を削除',
  notification_channels_update: '通知チャネル設定を更新',
  // §4.3 フォローアップ
  tenant_mode_update: '動作モードを変更',
  location_create: '拠点を作成',
  location_update: '拠点を更新',
  location_delete: '拠点を削除',
  inbound_token_regenerate: 'メール転送先アドレスを再発行',
  // フォローアップ (2026-07-11)
  invitation_issue: 'メンバー招待リンクを発行',
};

// 設定変更監査ログで actorId が null (システムによる自動変更) のときに表示する操作者名。
// §4.3 フォローアップ (2026-07-10): Stripe Webhook 起因の自動プランダウングレードのように、
// ユーザーが介在しない設定変更を「誰が」欄でどう表示するかを一元管理する
export const SETTINGS_AUDIT_SYSTEM_ACTOR_NAME = 'システム（自動）';

// メール取り込みが隔離した理由に対応する日本語表示ラベル。
// QuarantineReason 型 (src/domain/types.ts) / QuarantineReason enum (prisma/schema.prisma)
// に値を追加したらここも更新する (§3.2 フォローアップ)
export const QUARANTINE_REASON_LABELS: Record<QuarantineReason, string> = {
  plan_gate: 'プラン未対応（メール取り込みが利用できないプラン）',
  auth_fail: '送信元ドメイン認証（SPF/DKIM/DMARC）に失敗',
  unknown_sender: '未登録の送信者',
  thread_forbidden: '追記権限のない送信者',
  quota_exceeded: '月間の問い合わせ件数上限に到達',
};

// 通知種別の英語キーに対応する日本語表示ラベル
// NotificationType enum (prisma/schema.prisma) に値を追加したらここも更新する
export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  assigned: '担当割当',
  escalated: 'エスカレーション',
  commented: 'コメント',
  statusChanged: 'ステータス変更',
  priorityChanged: '優先度変更',
  imported: '一括取り込み', // CSV・メール一括インポートで複数チケットが追加されたことを通知する
};

// 変更履歴の oldValue / newValue を field 種別に応じて日本語表示に変換する関数
// status / escalation はステータス enum、priority は優先度 enum、assignee はユーザー名がそのまま入る
// mode を渡すと status/escalation のラベルをテナントの動作モードに合わせて切り替える (Lite なら 3 値)
// (旧呼び出し互換のため mode 省略時は 'pro' = 現行 7 値表記をデフォルトとする)
export function formatHistoryValue(
  field: string,
  value: string | null,
  mode: TenantMode = 'pro',
): string {
  // 値が null の場合は欠損プレースホルダ「―」を返す (担当者の初回割当など)
  if (value === null) return '―';
  // status / escalation はステータス enum 値なので mode-aware な getStatusLabel で日本語化する
  if (field === 'status' || field === 'escalation')
    return getStatusLabel(value as TicketStatus, mode);
  // priority は優先度 enum 値なので PRIORITY_LABELS で日本語化する
  if (field === 'priority') return PRIORITY_LABELS[value] ?? value;
  // assignee はユーザー名そのものが入っているので変換せずに返す
  return value;
}
