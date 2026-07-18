// 「表示用の既定上限」と「一括処理向けの網羅的な上限」の 2 段クランプを複数のリポジトリ
// (拠点・カテゴリ) が同じロジックで必要としたため、重複 (CLAUDE.md §6「2〜3 箇所目で共通化する」)
// を避けてここに集約する (audit-pagination.ts の resolveAuditLimit 集約と同じ方針)。

// 呼び出し側が指定した limit を [1, maxLimit] の範囲にクランプして返す。
// requested が未指定なら defaultLimit (表示用) を使う。指定時も maxLimit (一括処理向けの
// 網羅的な上限) を超えさせない (DoS・リソース枯渇防止の多層防御クランプ)
export function resolveListLimit(
  requested: number | undefined,
  defaultLimit: number,
  maxLimit: number,
): number {
  // 未指定なら表示用の既定値を返す
  if (requested === undefined) return defaultLimit;
  // 指定値を網羅的な上限以下にクランプする
  return Math.min(requested, maxLimit);
}
