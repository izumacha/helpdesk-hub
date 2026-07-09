// チケット状態型・テナントモード型 (lite | pro)・権限型を正準のドメイン型から 1 本でインポート
import type { TicketStatus, TenantMode, Role } from '@/domain/types';
// Lite モードの 3 値型と型ガード関数を取り込み、mode-aware ラベル関数で使う
import { isLiteStatus, type LiteStatus } from '@/domain/ticket-status';

// FAQ 候補化を許可するチケット状態一覧 (解決済みのみ候補化可能)
export const FAQ_ELIGIBLE_STATUSES: readonly TicketStatus[] = ['Resolved'];

// チケット状態の英語キーに対応する日本語表示ラベル (Pro モード、現行 7 値)
export const STATUS_LABELS: Record<string, string> = {
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
export const SETTINGS_AUDIT_ACTION_LABELS: Record<string, string> = {
  sso_config_update: 'SSO 設定を更新',
  sso_config_delete: 'SSO 設定を削除',
  line_config_update: 'LINE 連携設定を更新',
  line_config_delete: 'LINE 連携設定を削除',
  notification_channels_update: '通知チャネル設定を更新',
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
