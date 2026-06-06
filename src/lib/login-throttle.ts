/**
 * In-process failed-login throttle (issue #119).
 *
 * Sliding-window lockout for the Credentials password provider, which the
 * generic `enforceRateLimit` (mutation actions) does not cover. Only FAILED
 * attempts are counted; a successful login clears that key, so legitimate
 * users are not penalised for occasional typos.
 *
 * Keys:
 *  - by email (primary): NOT attacker-spoofable — it is the login target, so
 *    an account is protected from credential-stuffing regardless of source IP.
 *  - by client IP (best-effort): X-Forwarded-For can be forged without a
 *    trusted proxy, so this is a supplementary throttle for broad spraying,
 *    never the sole control.
 *
 * Same single-instance caveat as `rate-limit.ts` / `sse-subscribers.ts`: the
 * registry is an in-process Map and assumes one Next.js instance. Horizontal
 * scaling requires moving this to Redis / a shared store.
 */

// 窓内で許容する連続失敗回数 (これ以上はロックアウト)
export const LOGIN_MAX_FAILURES = 5;
// 失敗回数を数える時間窓 (15 分)
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;

// キー (email:... / ip:...) ごとの「失敗時刻」一覧を持つレジストリ
const failures = new Map<string, number[]>();

// cutoff より古い失敗時刻を捨てて、窓内に残る分だけ返すヘルパー
function prune(timestamps: number[], cutoff: number): number[] {
  // 配列は時系列順なので、先頭から cutoff 未満を数えれば境界がわかる
  let i = 0;
  // cutoff より古い要素数をカウントする
  while (i < timestamps.length && timestamps[i] < cutoff) i += 1;
  // 古いものが無ければそのまま、あればその分だけ切り落として返す
  return i === 0 ? timestamps : timestamps.slice(i);
}

// 指定キーが現在ロックアウト中か (窓内の失敗回数が上限以上か) を判定する
export function isLoginBlocked(key: string, now: number = Date.now()): boolean {
  // 窓の開始時刻を求める
  const cutoff = now - LOGIN_FAILURE_WINDOW_MS;
  // 窓内に残る失敗時刻だけに絞り込む
  const live = prune(failures.get(key) ?? [], cutoff);
  // 失敗履歴が空ならエントリを削除して未ブロックを返す (メモリ肥大防止)
  if (live.length === 0) {
    failures.delete(key);
    return false;
  }
  // 絞り込んだ履歴を書き戻す
  failures.set(key, live);
  // 窓内の失敗回数が上限以上ならブロック中
  return live.length >= LOGIN_MAX_FAILURES;
}

// 指定キーに対する「ログイン失敗」を 1 件記録する
export function recordLoginFailure(key: string, now: number = Date.now()): void {
  // 窓の開始時刻を求める
  const cutoff = now - LOGIN_FAILURE_WINDOW_MS;
  // 窓内に残る履歴に絞ってから今回の失敗を追記する
  const live = prune(failures.get(key) ?? [], cutoff);
  // 今回の失敗時刻を末尾に追加する
  live.push(now);
  // レジストリを更新する
  failures.set(key, live);
}

// 指定キーの失敗履歴を消去する (ログイン成功時に呼ぶ)
export function clearLoginFailures(key: string): void {
  // 該当キーのエントリを丸ごと削除する
  failures.delete(key);
}

// email から失敗カウント用のキーを作る (大文字小文字を無視するため小文字化)
export function loginEmailKey(email: string): string {
  // "email:" 接頭辞でIPキーと衝突しないようにする
  return `email:${email.trim().toLowerCase()}`;
}

// クライアント IP から失敗カウント用のキーを作る
export function loginIpKey(ip: string): string {
  // "ip:" 接頭辞で email キーと衝突しないようにする
  return `ip:${ip}`;
}

/** Testing helper: clear all failure buckets between test cases. */
// テスト間で状態を初期化するためのヘルパー (本番コードからは呼ばない)
export function __resetLoginThrottle(): void {
  // 全エントリを空にする
  failures.clear();
}
