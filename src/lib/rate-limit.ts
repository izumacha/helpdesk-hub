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

export type RateLimitOptions = {
  /** Max allowed hits within the window. */
  limit: number;
  /** Window size in milliseconds. */
  windowMs: number;
};

const buckets = new Map<string, number[]>();

function prune(timestamps: number[], cutoff: number): number[] {
  // Bucket entries are push-appended chronologically, so the first index
  // where `ts >= cutoff` bounds the live window.
  let i = 0;
  while (i < timestamps.length && timestamps[i] < cutoff) i += 1;
  return i === 0 ? timestamps : timestamps.slice(i);
}

export function enforceRateLimit(
  key: string,
  { limit, windowMs }: RateLimitOptions,
  now: number = Date.now(),
): void {
  const cutoff = now - windowMs;
  const existing = buckets.get(key) ?? [];
  const live = prune(existing, cutoff);

  if (live.length >= limit) {
    const retryAfterMs = Math.max(0, live[0] + windowMs - now);
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);
    throw new Error(`操作の頻度が高すぎます。${retryAfterSec}秒ほど待ってから再度お試しください。`);
  }

  live.push(now);
  buckets.set(key, live);
}

/** Testing helper: clear all buckets between test cases. */
export function __resetRateLimits(): void {
  buckets.clear();
}
