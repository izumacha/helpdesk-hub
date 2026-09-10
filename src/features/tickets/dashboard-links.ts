// 一覧 URL の組み立てを担う共通の純粋関数 (ページャ・タブ・絞り込みフォームと共有)
import { buildTicketsHref } from '@/features/tickets/tickets-href';

// ダッシュボード (/dashboard) から一覧 (/tickets) への drill-down リンクを組み立てる純粋関数。
//
// 監査で発見したギャップ対応 (2026-07-20): §4.1/§4.1.1 で Pro/Lite 両ダッシュボードに拠点
// フィルタ (locationId) を追加したが、ステータス別件数カード・担当者別ワークロード行・Lite の
// 2 枚タイルは、いずれも locationId を含めずに `/tickets` へリンクしていた。ダッシュボードで
// 拠点を選んだ状態からカード/タイルをクリックすると、遷移先の一覧では絞り込みが「全拠点」に
// 戻ってしまい、直前に見ていた件数と一覧の表示件数が一致しない (拠点フィルタが握り潰される)。
// このヘルパーで「既存のクエリ文字列 + 選択中の拠点」を 1 か所に集約し、4 箇所の呼び出し元
// (dashboard/page.tsx の Pro/Lite 両ブランチ) で書き写さないようにする (§6 DRY)。
//
// **URL の組み立て自体は buildTicketsHref に委譲する** (/code-review ultra 指摘対応)。
// 以前はここだけ文字列連結で `/tickets?...` を作っており、値のエスケープも page の
// リセットも掛かっていなかった (拠点 ID に URL で特別な意味を持つ文字が入ると壊れる)。
// 一覧側の 4 箇所を 1 つの純粋関数へ寄せた以上、5 つ目をここに残さない (§6 DRY)。
export function buildTicketListHref(
  baseQuery: string, // 拠点以外の絞り込み条件を表すクエリ文字列 (例: 'status=Open', 'tab=mine')
  locationId: string | undefined, // 選択中の拠点 ID (未選択 = 全拠点なら undefined)
): string {
  // クエリ文字列を解析して土台にする (キーの重複や順序はそのまま保たれる)
  const base = new URLSearchParams(baseQuery);
  // 拠点が選択されていればそれを足す (未選択なら土台のまま)
  return buildTicketsHref(base, locationId ? { set: { locationId } } : {});
}
