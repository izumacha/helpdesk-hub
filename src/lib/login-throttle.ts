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
 *
 * Availability tradeoff: a hard email lockout means someone who knows a
 * victim's email can keep that account locked by sending failed passwords.
 * This is inherent to failed-attempt lockout and is accepted here because it is
 * (a) bounded by the 15-minute rolling window (auto-recovers) and (b) escapable
 * via the magic-link login provider, which is intentionally NOT throttled — a
 * locked-out user can always sign in through the emailed one-time link. Do not
 * add throttling to the magic-link path without providing another recovery
 * route.
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

// failures 全体を走査し、窓内に 1 件も残っていないキーを Map から削除する。
// isLoginBlocked / clearLoginFailures が消せるのは「いま処理しているキー」だけなので、
// 一度しか現れないキーは誰にも再訪されず、prune() も走らないまま Map に残り続ける。
// このキー空間は未認証の攻撃者が自由に増やせる (毎回違うメールアドレス、偽装した
// X-Forwarded-For 由来の IP) ため、掃除が無いとプロセス再起動まで単調増加する。
// 定期実行ジョブが無いので rate-limit.ts の sweepStaleBuckets と同じく
// 「ながら掃除」にする (失敗記録の頻度がそのまま掃除頻度になる)。
function sweepStaleKeys(now: number): void {
  // 窓の開始時刻を求める (全キーで窓長が同じなので cutoff は 1 つで足りる)
  const cutoff = now - LOGIN_FAILURE_WINDOW_MS;
  // レジストリの全エントリを走査する
  for (const [key, timestamps] of failures) {
    // このキーの履歴のうち窓内に残る分だけに絞り込む
    const live = prune(timestamps, cutoff);
    if (live.length === 0) {
      // 窓内に 1 件も残っていない = もう追跡不要なのでエントリごと削除する
      failures.delete(key);
    } else if (live.length !== timestamps.length) {
      // 一部だけ古くなった場合は間引いた結果を書き戻す
      failures.set(key, live);
    }
  }
}

// 指定キーに対する「ログイン失敗」を 1 件記録する。
//
// **`now` には実時計を渡すこと（既定のまま使うのが正しい）。** 引数はテストから
// 窓の境界を動かすためのもので、本番の呼び出し元はすべて既定値を使っている。
// この関数は下で全キーの掃除も行うため、未来にずれた `now` を渡すと
// 「そのキーの窓」だけでなく **進行中のロックアウトが全部解除される**
// （掃除を入れる前は影響がそのキーだけに閉じていた）。
// 外部由来の時刻（Webhook のイベント時刻、監査ログの再生など）を渡さない。
export function recordLoginFailure(key: string, now: number = Date.now()): void {
  // 窓の開始時刻を求める
  const cutoff = now - LOGIN_FAILURE_WINDOW_MS;
  // 窓内に残る履歴に絞ってから今回の失敗を追記する
  const live = prune(failures.get(key) ?? [], cutoff);
  // 今回の失敗時刻を末尾に追加する
  live.push(now);
  // レジストリを更新する
  failures.set(key, live);
  // このキー以外も含めて、完全に期限切れになったエントリをここで掃除する
  sweepStaleKeys(now);
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

/** Testing helper: number of tracked keys (asserts the sweep actually reclaims). */
// レジストリに残っているキー数を返す (掃除が効いているかをテストから観測するための窓口)
export function __getLoginThrottleKeyCount(): number {
  // Map の現在のエントリ数をそのまま返す
  return failures.size;
}

/** Testing helper: clear all failure buckets between test cases. */
// テスト間で状態を初期化するためのヘルパー (本番コードからは呼ばない)
export function __resetLoginThrottle(): void {
  // 全エントリを空にする
  failures.clear();
}
