// 「未完了のみ」の絞り込み (?open=1) を一覧・ダッシュボードで共有する純粋関数群。
//
// /code-review ultra 指摘対応 (2026-09-15): ダッシュボードの担当者別ワークロードは
// 終息ステータス (Resolved / Closed) を除いた件数を表示し、リンクの読み上げ名も
// 「〇〇 の未完了 N 件の一覧を見る」と件数の意味を明言していた。ところが drill-down 先の
// URL は `?assigneeId=...` だけで状態条件を持たず、遷移すると完了済みまで含む全件が並ぶ。
// タイルの数字と一覧の件数が食い違う — PR #326 が SLA タイルについて解消したはずの
// ずれが、同じ画面のワークロード行にだけ残っていた (しかも読み上げ名が誤った件数を
// 明言するぶん、a11y の観点ではより悪い)。
//
// 「未完了」を URL で表現する手段が無かったのが原因なので、タブ (tab-filter.ts)・
// 期限 (due-filter.ts) と同じ「単一の真実の源」パターンでここに 1 か所だけ定義する。

// データ層が公開しているチケット一覧フィルタ型 (状態条件を差し込む対象)
import type { TicketListFilter } from '@/data/ports/ticket-repository';
// 終息していないステータス一覧 (ドメインの唯一の参照元から導出された値を使う)
import { UNRESOLVED_STATUSES } from '@/domain/ticket-status';

// URL クエリのキー名 (ダッシュボードのリンク組み立てと一覧の解除リンクで共有する)
export const OPEN_FILTER_PARAM = 'open';

// 絞り込みが有効なときの値。真偽値を URL で表すので '1' 固定にする
// (「'true' も許す」のような揺れを作らない。parseOpenParam が唯一の読み手)
export const OPEN_FILTER_VALUE = '1';

// 一覧の「絞り込み中」チップに出す日本語ラベル
// (ダッシュボード側のリンク読み上げ名と同じ「未完了」という言葉を使い、
//  タイルの数字と一覧が同じものを指していることが画面から読み取れるようにする)
export const OPEN_FILTER_LABEL = '未完了のみ';

/**
 * URL クエリの open を真偽値に正規化する。
 *
 * parseTabParam / parseDueParam と同じ「決めた値に完全一致するときだけ採用する」方針。
 * URL は信頼できない入力なので、'1' 以外 (未指定・空文字・'0'・'true' など) は
 * すべて「絞り込みなし」に倒す (§9 入力は信用しない)。
 */
export function parseOpenParam(raw: string | undefined): boolean {
  // 決めた値に完全一致するときだけ絞り込みを有効にする
  return raw === OPEN_FILTER_VALUE;
}

/**
 * 「未完了のみ」条件を base フィルタに追加して返す (applyTabFilter / applyDueFilter と
 * 同じ非破壊の複製方式)。
 *
 * **既に statusIn が入っている場合は積集合を取る。** 上書きすると、`?tab=mine&open=1` の
 * ように両方が状態条件を立てる組み合わせで片方が黙って消える (status と statusIn が
 * 上書きし合っていた不具合とまったく同じ形)。積集合が空になる組み合わせは
 * 「どの状態にも当てはまらない = 0 件」を意味し、空配列のままデータ層へ渡す
 * (アダプタは空の statusIn を 0 件として扱う契約。TicketListFilter の docstring 参照)。
 */
export function applyOpenFilter(base: TicketListFilter): TicketListFilter {
  // base を直接書き換えないよう浅いコピーを作る (呼び出し側の filter を汚さない)
  const filter: TicketListFilter = { ...base };
  // 既存の statusIn が無ければ未完了ステータス一覧をそのまま条件にする
  if (!base.statusIn) {
    filter.statusIn = [...UNRESOLVED_STATUSES];
    return filter;
  }
  // 既存の statusIn があるときは積集合を取る (どちらの条件も満たす状態だけを残す)
  filter.statusIn = base.statusIn.filter((status) => UNRESOLVED_STATUSES.includes(status));
  return filter;
}
