// 期限ベースの絞り込み (?due=...) を一覧・ダッシュボードで共有する純粋関数群。
//
// 監査フォローアップ (2026-09-09): ダッシュボードの SLA 系タイルには drill-down 先が無く、
// 「最も緊急な数字だけがクリックできない」状態だった。タブ ('mine' / 'overdue') と同じ考え方で
// 「期限間近」「期限切れ・今日まで」の絞り込み条件をここに 1 か所で定義し、
// ダッシュボードの件数とタイルから遷移した一覧の表示件数が必ず一致するようにする
// (tab-filter.ts と同じ「単一の真実の源」パターン。§6 DRY)。
// - 'soon'  : 期限間近 = 解決期限が警告帯 (now 〜 now + DEFAULT_WARNING_THRESHOLD_MS) 内の未解決
//             (src/lib/sla.ts の getSlaState が 'warning' と判定する範囲と同じ定義)
// - 'today' : 期限切れ・今日まで = 解決期限が「今日 (JST) の終わり」以前の未解決
//             (Pivot plan §3.1 の Lite タイル「期限切れ・今日まで」の定義)

// データ層が公開しているチケット一覧フィルタ型 (期限条件を差し込む対象)
import type { TicketListFilter } from '@/data/ports/ticket-repository';
// SLA の日本語ラベル (「期限間近」の呼び名の唯一の参照元。§6 一元管理)
import { SLA_LABELS } from '@/lib/sla';
// JST の「今日」の日付文字列化と、その日の終端 (23:59:59.999 JST) の計算 (既存共通関数を再利用)
// (警告帯の幅そのものは各アダプタが sla.ts の DEFAULT_WARNING_THRESHOLD_MS を参照して展開する)
import { formatDateISO, endOfDayJST } from '@/lib/format-date';

// 期限絞り込みの識別子型 (URL クエリ ?due=... と対応する値)
export type TicketDueId = 'soon' | 'today';

// 期限絞り込みの日本語表示ラベル (一覧の「絞り込み中」チップとダッシュボードのタイルで共有)
export const DUE_FILTER_LABELS: Record<TicketDueId, string> = {
  // SLA 警告帯 (残り DEFAULT_WARNING_THRESHOLD_MS 以内) の未解決。
  // /code-review ultra 指摘対応: タイル側が表示する SLA_LABELS.warning と同じ概念のため
  // 文字列を書き写さず導出する (片方だけ改名されて画面間で呼び名が食い違うのを防ぐ §6)
  soon: SLA_LABELS.warning,
  today: '期限切れ・今日まで', // 期限超過 + 今日が期限の未解決 (Lite タイルの定義。Pivot plan §3.1)
};

/**
 * URL クエリの due を TicketDueId に正規化する。不正値・未指定は undefined (絞り込みなし)。
 * (parseTabParam と同じ「列挙に一致するときだけ採用する」方針。URL は信頼できない入力のため)
 */
export function parseDueParam(raw: string | undefined): TicketDueId | undefined {
  // 'soon' か 'today' に完全一致する場合のみ採用、それ以外は絞り込みなし
  if (raw === 'soon' || raw === 'today') return raw;
  return undefined;
}

/**
 * 期限絞り込み条件を base フィルタに「追加」して返す (applyTabFilter と同じ非破壊の複製方式)。
 * - 'soon'  : dueSoon 条件 (アダプタ側が警告帯 [now, now + 閾値) に展開する)
 * - 'today' : dueUntil 条件 (今日の JST 終端以前が期限。期限超過ぶんも含む)
 */
export function applyDueFilter(
  base: TicketListFilter,
  due: TicketDueId,
  ctx: { now: Date }, // 現在時刻 (警告帯・「今日」の基準)
): TicketListFilter {
  // base を直接書き換えないよう浅いコピーを作る (呼び出し側の filter を汚さない)
  const filter: TicketListFilter = { ...base };
  // 'soon': 警告帯の基準時刻を渡す (帯の幅はアダプタが DEFAULT_WARNING_THRESHOLD_MS で共有)
  if (due === 'soon') {
    filter.dueSoon = { now: ctx.now };
    return filter;
  }
  // 'today': 「今日 (JST) の終わり」を境界にする。
  // endOfDayJST は不正な日付文字列で null を返しうるが、formatDateISO(now) は常に
  // 正しい 'YYYY-MM-DD' を返すため null は環境異常 (Intl 実装異常等) を意味する。
  // 黙って「絞り込みなし」にフォールバックすると全件が「期限切れ・今日まで」として
  // 表示されてしまうため、fail-closed で例外にする (§9 失敗しても安全側に倒す)
  const until = endOfDayJST(formatDateISO(ctx.now));
  if (!until) {
    throw new Error('applyDueFilter: JST の今日の終端を計算できませんでした');
  }
  // 今日の終端「以前」が期限の未解決チケットに絞る条件を付ける
  filter.dueUntil = { until };
  return filter;
}
