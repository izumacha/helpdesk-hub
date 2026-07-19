// 優先度を表すドメイン型 (Low/Medium/High) をインポート
import type { Priority } from '@/domain/types';

// SLA (サービス提供期限) の現在状態を表す文字列型
// 'ok' = 余裕あり / 'warning' = 期限間近 / 'overdue' = 超過 / 'none' = 未設定
export type SlaState = 'ok' | 'warning' | 'overdue' | 'none';

/**
 * Hours allowed to resolve a ticket, by priority. Placeholder business policy —
 * replace with a config/DB-backed source once requirements are finalized.
 */
// 優先度ごとの「解決までに許される時間 (時間単位)」
export const SLA_RESOLUTION_HOURS_BY_PRIORITY: Record<Priority, number> = {
  High: 24, // 優先度高: 24 時間 (1 日)
  Medium: 72, // 優先度中: 72 時間 (3 日)
  Low: 168, // 優先度低: 168 時間 (7 日)
};

// 起票時刻 from から優先度に応じた解決期限を計算して返す関数
export function calculateResolutionDueAt(priority: Priority, from: Date): Date {
  // 表から対応する時間数を取得
  const hours = SLA_RESOLUTION_HOURS_BY_PRIORITY[priority];
  // from の時刻 (ミリ秒) に hours 時間分のミリ秒を加えた新しい Date を返す
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

/**
 * Hours allowed for the first response, by priority. Same placeholder-policy
 * caveat as SLA_RESOLUTION_HOURS_BY_PRIORITY (shorter than the resolution
 * window since a first response is a much lighter action than resolving).
 */
// 優先度ごとの「初回応答までに許される時間 (時間単位)」
export const FIRST_RESPONSE_HOURS_BY_PRIORITY: Record<Priority, number> = {
  High: 4, // 優先度高: 4 時間
  Medium: 8, // 優先度中: 8 時間 (営業時間内)
  Low: 24, // 優先度低: 24 時間 (1 日)
};

// 起票時刻 from から優先度に応じた初回応答期限を計算して返す関数
export function calculateFirstResponseDueAt(priority: Priority, from: Date): Date {
  // 表から対応する時間数を取得
  const hours = FIRST_RESPONSE_HOURS_BY_PRIORITY[priority];
  // from の時刻 (ミリ秒) に hours 時間分のミリ秒を加えた新しい Date を返す
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

// 「警告 (期限間近)」とみなす残り時間のデフォルト閾値 (24 時間)。
// 解決期限 (24〜168 時間の窓) 向けに調整された値。初回応答期限は窓が 4〜24 時間と
// 短いため、この既定値をそのまま使うと起票直後から常に warning になってしまう
// (回帰防止: getSlaState の呼び出し側は窓の長さに応じた閾値を明示的に渡すこと)
// issue-backlog #20 フォローアップ: SLA 期限接近リマインダー (src/lib/sla-reminder.ts) の
// DB 側の絞り込みクエリでも同じ「警告帯」の窓を使うため export する (§6 一元管理: 画面バッジと
// リマインダー通知の「期限間近」の定義を同じ 1 つの値に揃え、別々に定義してずれるのを防ぐ)
export const DEFAULT_WARNING_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// 期限日時と解決日時から現在の SLA 状態を判定する関数。
// warningThresholdMs: 「期限間近」とみなす残り時間 (ミリ秒)。省略時は解決期限向けの
// 24 時間。初回応答期限のように窓自体が短い SLA では、呼び出し側が窓の長さに応じた
// 値 (例: 窓の 25%) を渡すことで、起票直後からずっと warning になる誤表示を防ぐ
export function getSlaState(
  resolutionDueAt: Date | null,
  resolvedAt: Date | null,
  warningThresholdMs: number = DEFAULT_WARNING_THRESHOLD_MS,
): SlaState {
  // 期限が未設定なら 'none' (対象外)
  if (!resolutionDueAt) return 'none';
  // 既に解決済みなら 'ok' (問題なく終わった扱い)
  if (resolvedAt) return 'ok';

  // 現在時刻を取得
  const now = new Date();
  // 期限までの残りミリ秒を計算
  const msLeft = resolutionDueAt.getTime() - now.getTime();

  // 残り時間がマイナスなら超過
  if (msLeft < 0) return 'overdue';
  // 残りが閾値未満なら警告
  if (msLeft < warningThresholdMs) return 'warning';
  // それ以外は余裕あり
  return 'ok';
}

// SLA 状態ごとに画面に表示するラベル文言
export const SLA_LABELS: Record<SlaState, string> = {
  ok: '', // 問題なしなら非表示
  warning: '期限間近',
  overdue: '期限超過',
  none: '', // 対象外も非表示
};

// SLA 状態ごとに適用する Tailwind カラークラス (バッジの色)
export const SLA_COLORS: Record<SlaState, string> = {
  ok: '',
  warning: 'bg-yellow-100 text-yellow-700', // 黄色系
  overdue: 'bg-red-100 text-red-700', // 赤系
  none: '',
};
