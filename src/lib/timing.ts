// 汎用の非同期タイミング調整ヘルパー。
// マジックリンク発行・セルフサーブサインアップ発行の両方が「ユーザー列挙耐性のため、
// 処理の実際の所要時間に関わらず最低限の遅延を保証する」という同じ仕組みを必要とするため、
// 2 箇所目の複製が生じる前にここへ集約する (§6 DRY)。

// 「ユーザーが見つからない」経路で挿入するダミー遅延 (ms)。
// DB lookup + token 生成 + email 送信の合計レイテンシを擬似的に揃える狙い。
// 注意: これは「最低保証」であって「固定エンベロープ」ではない。SMTP 送信を伴う既知経路は
// 未知経路よりなお時間がかかりうるため、タイミングサイドチャネルを完全には塞げない
// (実際の配送をキュー化する、または最悪ケース固定長までパディングすることが必要。
// フォローアップ課題として据え置く)。
// /code-review ultra 指摘対応 (2026-07-13): request-magic-link.ts と request-signup.ts が
// 同じ値をそれぞれ独立に定義していたため、§6 DRY (定数の一元管理) に従いここへ集約する
export const ENUMERATION_MASK_DELAY_MS = 150;

// 渡された Promise を必ず指定 ms 以上かかるように引き伸ばすヘルパー
export async function atLeast<T>(promise: Promise<T>, ms: number): Promise<T> {
  // 本処理と sleep を並行に走らせて両方の完了を待つ
  const [value] = await Promise.all([promise, new Promise<void>((r) => setTimeout(r, ms))]);
  return value;
}
