// ダッシュボード (/dashboard) から一覧 (/tickets) への drill-down リンクを組み立てる純粋関数。
//
// 監査で発見したギャップ対応 (2026-07-20): §4.1/§4.1.1 で Pro/Lite 両ダッシュボードに拠点
// フィルタ (locationId) を追加したが、ステータス別件数カード・担当者別ワークロード行・Lite の
// 2 枚タイルは、いずれも locationId を含めずに `/tickets` へリンクしていた。ダッシュボードで
// 拠点を選んだ状態からカード/タイルをクリックすると、遷移先の一覧では絞り込みが「全拠点」に
// 戻ってしまい、直前に見ていた件数と一覧の表示件数が一致しない (拠点フィルタが握り潰される)。
// このヘルパーで「既存のクエリ文字列 + 選択中の拠点」を 1 か所に集約し、4 箇所の呼び出し元
// (dashboard/page.tsx の Pro/Lite 両ブランチ) で書き写さないようにする (§6 DRY)。
export function buildTicketListHref(
  baseQuery: string, // 拠点以外の絞り込み条件を表すクエリ文字列 (例: 'status=Open', 'tab=mine')
  locationId: string | undefined, // 選択中の拠点 ID (未選択 = 全拠点なら undefined)
): string {
  // 拠点が選択されていなければ、拠点以外の条件だけで一覧へ遷移する (今までと同じ挙動)
  if (!locationId) return `/tickets?${baseQuery}`;
  // 選択中の拠点を維持したまま一覧へ遷移する (一覧側の locationId 解釈は tickets/page.tsx が担う)
  return `/tickets?${baseQuery}&locationId=${locationId}`;
}
