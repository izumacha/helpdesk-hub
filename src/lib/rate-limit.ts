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

// 1 キー分のバケット。タイムスタンプ配列に加えて、そのキーの直近の呼び出しで
// 使われた windowMs も保持する (キーごとに異なる呼び出し元が異なる窓長を渡すため、
// 掃除処理で「このバケットはもう完全に期限切れか」を判定するのに必要)
type Bucket = {
  timestamps: number[]; // 実行タイムスタンプの一覧 (時系列昇順)
  windowMs: number; // このバケットの直近呼び出し時の時間窓長 (ミリ秒)
};

// キー (userId:scope や userId:scope:ticketId 等) ごとのバケットを持つ Map。
// `ticket-status:${userId}:${ticketId}` のようにチケット ID を含む使い捨てキーは
// 一度しか呼ばれず二度と prune されないため、何もしないと Map が単調増加する。
// enforceRateLimit の呼び出しごとに sweepStaleBuckets() で全体を掃除することで
// 実質的に「アクティブな (直近 windowMs 以内に呼ばれた) キーの数」に上限を保つ。
const buckets = new Map<string, Bucket>();

// レート制限超過を表す専用エラー。
// Server Action からは従来どおり Error として message が画面に surface する一方、
// Route Handler 側では instanceof で判別して HTTP 429 + Retry-After にマップできる。
export class RateLimitError extends Error {
  // あと何秒待てば再試行できるか (Retry-After ヘッダ / UI 表示に使う)
  readonly retryAfterSec: number;
  constructor(message: string, retryAfterSec: number) {
    super(message); // 日本語メッセージを Error.message に乗せる
    this.name = 'RateLimitError'; // スタックトレース等での識別用
    this.retryAfterSec = retryAfterSec; // 再試行までの待ち秒数を保持
  }
}

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
  const existing = buckets.get(key)?.timestamps ?? [];
  // 窓内に残る履歴だけに絞り込む
  const live = prune(existing, cutoff);

  // 既に上限に達していた場合はエラーを投げる
  if (live.length >= limit) {
    // 最古の記録が窓から抜けるまでの待ち時間 (ミリ秒) を算出
    const retryAfterMs = Math.max(0, live[0] + windowMs - now);
    // 切り上げて秒単位に変換 (ユーザーに見せる用)
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);
    // 日本語メッセージ付きの専用エラーを投げる。
    // Server Action 経由なら message が画面に出る / Route Handler なら 429 にマップされる
    throw new RateLimitError(
      `操作の頻度が高すぎます。${retryAfterSec}秒ほど待ってから再度お試しください。`,
      retryAfterSec,
    );
  }

  // 今回の実行時刻を履歴の末尾に追加
  live.push(now);
  // バケットを更新して保存 (このキー自身の windowMs も一緒に覚えておく)
  buckets.set(key, { timestamps: live, windowMs });

  // このキー以外のバケットも含めて、既に完全に期限切れになったものを掃除する。
  // cron 等の定期実行ジョブが無いため、enforceRateLimit の呼び出しに便乗して
  // 「ながら掃除」する (呼び出し頻度がそのまま掃除頻度になる)。
  sweepStaleBuckets(now);
}

// buckets 全体を走査し、prune() 後に空配列になったバケットを Map から削除する。
// 各バケットは自分自身が最後に使われた時の windowMs を保持しているため、
// そのバケット固有の cutoff で判定できる (呼び出し元ごとに窓長が異なっても正しく動く)。
// `ticket-status:${userId}:${ticketId}` のように一度しか呼ばれないキーは、
// この掃除がなければ prune() 済みの空配列にすらならず Map に残り続けてしまう
// (prune はローカル変数を返すだけで Map を書き換えないため)。
function sweepStaleBuckets(now: number): void {
  // Map の全エントリを走査する
  for (const [key, bucket] of buckets) {
    // このバケット自身の窓長を基準に cutoff を計算する
    const cutoff = now - bucket.windowMs;
    // 窓内に残る履歴だけに絞り込む
    const live = prune(bucket.timestamps, cutoff);
    if (live.length === 0) {
      // 生き残りが 0 件 = このキーはもう追跡不要なので Map から削除する
      buckets.delete(key);
    } else if (live.length !== bucket.timestamps.length) {
      // 一部だけ間引かれた場合は、間引いた結果で Map を更新しておく
      buckets.set(key, { timestamps: live, windowMs: bucket.windowMs });
    }
  }
}

// Server Action で使う定型ラッパー。`{error}` を返す契約のアクション (useActionState 互換や
// create/update/delete-location.ts のような非throw系アクション) は元々 enforceRateLimit の
// try/catch を各所で手書きしていたが、8 箇所目で完全に同一の 6 行を複製する状態になった
// (CLAUDE.md §6 の「2〜3 箇所目で共通化する」を超過)。この関数に集約し、レート制限超過なら
// ユーザー向けメッセージを、問題なければ null を返す (呼び出し側は `if (msg) return {error: msg}`
// と 1 行で済ませられる)。
export function checkRateLimit(
  key: string, // "userId:scope" や "tenantId:scope" 形式のキー
  options: RateLimitOptions, // 制限値
  now?: number, // 現在時刻 (テスト時に差し替えできるよう引数化。省略時は Date.now())
): string | null {
  try {
    enforceRateLimit(key, options, now);
    // 超過していなければ null (エラー無し)
    return null;
  } catch (err) {
    // RateLimitError の日本語メッセージ、それ以外は汎用メッセージにフォールバック
    return err instanceof Error ? err.message : 'しばらく時間をおいて再度お試しください';
  }
}

/** Testing helper: clear all buckets between test cases. */
// テスト間で状態を初期化するためのヘルパー関数 (本番コードからは呼ばない)
export function __resetRateLimits(): void {
  // 全バケットを空にする
  buckets.clear();
}

/** Testing helper: current number of tracked keys (used to assert no memory leak). */
// buckets Map が保持しているキー数を返すテスト専用ヘルパー (本番コードからは呼ばない)
export function __getRateLimitBucketCount(): number {
  // Map のサイズをそのまま返す
  return buckets.size;
}
