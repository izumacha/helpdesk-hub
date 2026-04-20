/**
 * In-process sliding-window rate limiter for Server Actions.
 *
 * Applied to mutation actions (`update-ticket`, `faq-actions`, …) so a single
 * user cannot spam status changes / escalations and flood every agent's
 * notification stream (see issue #66).
 *
 * Constraints:
 * - Keyed by `userId:scope`; one user's quota does not affect another's.
 * - Sliding window measured against `Date.now()` — rejections throw an
 *   `Error` whose Japanese message surfaces to the user via the Server
 *   Action error channel.
 * - The registry is an in-process `Map`; it shares the same "single
 *   Next.js instance" assumption as `sse-subscribers.ts`. Horizontal
 *   scaling requires replacing this with Redis / a shared store.
 */

// レートリミット (流量制限) の設定を表す型
export type RateLimitOptions = {
  /** Max allowed hits within the window. */
  limit: number; // 窓内で許容される最大回数
  /** Window size in milliseconds. */
  windowMs: number; // 判定に使う時間窓の長さ (ミリ秒)
};

// キー (userId:scope) ごとの実行タイムスタンプ一覧を持つバケット
const buckets = new Map<string, number[]>();

// cutoff より古いタイムスタンプを配列から捨てて、生き残りだけ返すヘルパー関数
function prune(timestamps: number[], cutoff: number): number[] {
  // Bucket entries are push-appended chronologically, so the first index
  // where `ts >= cutoff` bounds the live window.
  // 配列は時系列順なので、先頭から cutoff 未満を数えるだけで境界がわかる
  let i = 0;
  // cutoff より古い要素の数を数える
  while (i < timestamps.length && timestamps[i] < cutoff) i += 1;
  // 何も古くなければそのまま、古いものがあればその分を切り落として返す
  return i === 0 ? timestamps : timestamps.slice(i);
}

// 指定キーに対してレート制限を適用し、超過していれば日本語メッセージでエラーを投げる関数
export function enforceRateLimit(
  key: string, // "userId:scope" 形式のキー (ユーザーと操作種別を識別)
  { limit, windowMs }: RateLimitOptions, // 制限値
  now: number = Date.now(), // 現在時刻 (テスト時に差し替えできるよう引数化)
): void {
  // 窓の開始時刻を計算 (この時刻より古い記録は無視)
  const cutoff = now - windowMs;
  // 既存の履歴を取得 (なければ空配列)
  const existing = buckets.get(key) ?? [];
  // 窓内に残る履歴だけに絞り込む
  const live = prune(existing, cutoff);

  // 既に上限に達していた場合はエラーを投げる
  if (live.length >= limit) {
    // 最古の記録が窓から抜けるまでの待ち時間 (ミリ秒) を算出
    const retryAfterMs = Math.max(0, live[0] + windowMs - now);
    // 切り上げて秒単位に変換 (ユーザーに見せる用)
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);
    // 日本語メッセージ付きでエラーを投げ、Server Action 経由で画面に表示させる
    throw new Error(`操作の頻度が高すぎます。${retryAfterSec}秒ほど待ってから再度お試しください。`);
  }

  // 今回の実行時刻を履歴の末尾に追加
  live.push(now);
  // バケットを更新して保存
  buckets.set(key, live);
}

/** Testing helper: clear all buckets between test cases. */
// テスト間で状態を初期化するためのヘルパー関数 (本番コードからは呼ばない)
export function __resetRateLimits(): void {
  // 全バケットを空にする
  buckets.clear();
}
