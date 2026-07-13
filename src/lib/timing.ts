// 汎用の非同期タイミング調整ヘルパー。
// マジックリンク発行・セルフサーブサインアップ発行の両方が「ユーザー列挙耐性のため、
// 処理の実際の所要時間に関わらず最低限の遅延を保証する」という同じ仕組みを必要とするため、
// 2 箇所目の複製が生じる前にここへ集約する (§6 DRY)。

// 渡された Promise を必ず指定 ms 以上かかるように引き伸ばすヘルパー
export async function atLeast<T>(promise: Promise<T>, ms: number): Promise<T> {
  // 本処理と sleep を並行に走らせて両方の完了を待つ
  const [value] = await Promise.all([promise, new Promise<void>((r) => setTimeout(r, ms))]);
  return value;
}
