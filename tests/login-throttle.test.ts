// Vitest のテスト DSL (フック/グルーピング/期待値/個別テスト)
import { beforeEach, describe, expect, it } from 'vitest';

// ログイン失敗スロットルの本体と、テスト用に内部状態をリセットする関数
import {
  __getLoginThrottleKeyCount,
  __resetLoginThrottle,
  clearLoginFailures,
  isLoginBlocked,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_MAX_FAILURES,
  loginEmailKey,
  loginIpKey,
  recordLoginFailure,
} from '../src/lib/login-throttle';

// ログイン失敗スロットル (issue #119) の仕様確認テスト群
describe('login-throttle', () => {
  // 各テストの前に失敗履歴をクリアしてテスト間の独立を保つ
  beforeEach(() => {
    __resetLoginThrottle();
  });

  // 失敗が無いキーはブロックされない
  it('does not block a key with no recorded failures', () => {
    // 何も記録していないキーは未ブロック
    expect(isLoginBlocked('email:foo@example.com')).toBe(false);
  });

  // 上限未満の失敗ではブロックされない
  it('does not block while failures stay below the limit', () => {
    // 基準時刻 (固定値で再現性確保)
    const now = 1_000_000;
    // 上限 - 1 回だけ失敗を記録する
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) {
      recordLoginFailure('email:foo@example.com', now + i);
    }
    // まだ上限に達していないのでブロックされない
    expect(isLoginBlocked('email:foo@example.com', now + LOGIN_MAX_FAILURES)).toBe(false);
  });

  // 上限に達した失敗でブロックされる
  it('blocks once failures reach the limit within the window', () => {
    // 基準時刻
    const now = 1_000_000;
    // 上限ちょうどまで失敗を記録する
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      recordLoginFailure('email:foo@example.com', now + i);
    }
    // 上限に達したのでブロックされる
    expect(isLoginBlocked('email:foo@example.com', now + LOGIN_MAX_FAILURES)).toBe(true);
  });

  // 窓から古い失敗が抜ければ再びブロックが解ける
  it('unblocks once old failures age out of the window', () => {
    // 基準時刻
    const t0 = 1_000_000;
    // 上限まで失敗を記録してブロック状態にする
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      recordLoginFailure('email:foo@example.com', t0 + i);
    }
    // 直後はブロックされている
    expect(isLoginBlocked('email:foo@example.com', t0 + LOGIN_MAX_FAILURES)).toBe(true);
    // 窓を 1ms 超えて時間を進めると、全ての失敗が窓外になる
    const later = t0 + LOGIN_FAILURE_WINDOW_MS + 1;
    // 古い失敗が抜けたのでブロックは解除される
    expect(isLoginBlocked('email:foo@example.com', later)).toBe(false);
  });

  // 成功時クリアでブロックが即解除される
  it('clears failures so a key is no longer blocked', () => {
    // 基準時刻
    const now = 1_000_000;
    // 上限まで失敗を記録してブロックする
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      recordLoginFailure('email:foo@example.com', now + i);
    }
    // ログイン成功を模して失敗履歴をクリアする
    clearLoginFailures('email:foo@example.com');
    // クリア後はブロックされない
    expect(isLoginBlocked('email:foo@example.com', now + LOGIN_MAX_FAILURES)).toBe(false);
  });

  // email キーと IP キーは独立して数えられる
  it('counts email and IP keys independently', () => {
    // 基準時刻
    const now = 1_000_000;
    // email キー側だけを上限まで失敗させる
    const emailKey = loginEmailKey('foo@example.com');
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      recordLoginFailure(emailKey, now + i);
    }
    // email キーはブロックされる
    expect(isLoginBlocked(emailKey, now + LOGIN_MAX_FAILURES)).toBe(true);
    // IP キーは一度も失敗していないのでブロックされない
    expect(isLoginBlocked(loginIpKey('1.2.3.4'), now + LOGIN_MAX_FAILURES)).toBe(false);
  });

  // email キーは大文字小文字を区別しない (同一アカウント扱い)
  it('treats email keys case-insensitively', () => {
    // 大文字混じりと小文字で同じキーになることを確認する
    expect(loginEmailKey('Foo@Example.com')).toBe(loginEmailKey('foo@example.com'));
  });

  // 使い捨てキー (毎回違うメールアドレス / 偽装した X-Forwarded-For 由来の IP) は
  // 二度と参照されないので、掃除が無いとレジストリがプロセス再起動まで単調増加する。
  // 未認証の攻撃者が自由に増やせるキー空間なので、これはメモリ枯渇 DoS になる。
  it('reclaims one-shot keys instead of growing without bound', () => {
    // 窓の起点となる時刻を決める
    const start = Date.now();
    // 毎回異なるキーで失敗を記録する (攻撃者が使い捨てメールを送り続ける状況)
    for (let i = 0; i < 50; i += 1) {
      recordLoginFailure(`email:one-shot-${i}@example.com`, start);
    }
    // この時点では 50 件すべてが窓内なので、まだ保持されているのが正しい
    expect(__getLoginThrottleKeyCount()).toBe(50);

    // 窓を 1 つ分過ぎたあとに、無関係なキーで 1 件だけ失敗を記録する
    recordLoginFailure('email:later@example.com', start + LOGIN_FAILURE_WINDOW_MS + 1);

    // 期限切れの 50 件は掃除され、いま記録した 1 件だけが残っている。
    // (掃除が無いと 51 件のまま残り、この数字は増え続ける)
    expect(__getLoginThrottleKeyCount()).toBe(1);
  });

  // 掃除は「期限切れのキー」だけを消す。窓内で進行中のロックアウトを巻き込んではいけない
  it('does not drop keys that still have failures inside the window', () => {
    // 窓の起点となる時刻を決める
    const start = Date.now();
    // 被害者のアカウントを上限まで失敗させてロックアウト状態にする
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      recordLoginFailure(loginEmailKey('victim@example.com'), start);
    }
    // ロックアウトが成立していることを確認する
    expect(isLoginBlocked(loginEmailKey('victim@example.com'), start)).toBe(true);

    // まだ窓内である時刻に、別のキーで失敗を記録して掃除を走らせる
    recordLoginFailure('email:other@example.com', start + 1);

    // 掃除が走っても被害者のロックアウトは維持されていなければならない
    expect(isLoginBlocked(loginEmailKey('victim@example.com'), start + 1)).toBe(true);
  });

  // 掃除の境界。窓のちょうど端ではまだ残り、1 ミリ秒過ぎて初めて解放されること。
  // これが無いと「窓の途中で掃除しても消えない」ことしか見ておらず、
  // cutoff がずれる退行（窓を短くする／長くする）を捕まえられない
  it('keeps a lockout at the window edge and releases it one ms later', () => {
    // 窓の起点となる時刻を決める
    const start = Date.now();
    // 被害者のアカウントを上限まで失敗させてロックアウト状態にする
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      recordLoginFailure(loginEmailKey('edge@example.com'), start);
    }

    // 窓のちょうど端（= 失敗時刻が cutoff と等しい）ではまだロックアウトが続く
    expect(isLoginBlocked(loginEmailKey('edge@example.com'), start + LOGIN_FAILURE_WINDOW_MS)).toBe(
      true,
    );

    // 1 ミリ秒過ぎると窓から出るので解放される
    expect(
      isLoginBlocked(loginEmailKey('edge@example.com'), start + LOGIN_FAILURE_WINDOW_MS + 1),
    ).toBe(false);
  });

  // 掃除が「一部だけ古くなったキー」を書き戻す枝（消さずに間引く）を通す。
  // ここを通らないと、生き残ったキーを変更する唯一の分岐が未検査のまま残る
  it('prunes stale timestamps from a surviving key without releasing it', () => {
    // 窓の起点となる時刻を決める
    const start = Date.now();
    // 上限に 1 件足りない回数だけ、窓の先頭で失敗させる（これらは後で窓から出る）
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) {
      recordLoginFailure(loginEmailKey('partial@example.com'), start);
    }
    // 窓の終わり際にもう 1 件失敗させる（合計が上限に達してロックアウトになる）
    const late = start + LOGIN_FAILURE_WINDOW_MS - 1;
    recordLoginFailure(loginEmailKey('partial@example.com'), late);
    // この時点ではロックアウトされている
    expect(isLoginBlocked(loginEmailKey('partial@example.com'), late)).toBe(true);

    // 古い分だけが窓から出る時刻に、別のキーで失敗を記録して掃除を走らせる。
    // このキーは「一部だけ間引かれて生き残る」ので、書き戻しの枝を通る
    const afterOldExpired = start + LOGIN_FAILURE_WINDOW_MS + 1;
    recordLoginFailure('email:unrelated@example.com', afterOldExpired);

    // キー自体は消えていない（新しい 1 件が窓内に残っているため）
    expect(__getLoginThrottleKeyCount()).toBe(2);
    // ただし残り 1 件では上限に達しないのでロックアウトは解けている
    expect(isLoginBlocked(loginEmailKey('partial@example.com'), afterOldExpired)).toBe(false);
    // もう一度上限まで失敗させれば再びロックアウトできる（履歴が壊れていないことの確認）
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) {
      recordLoginFailure(loginEmailKey('partial@example.com'), afterOldExpired);
    }
    expect(isLoginBlocked(loginEmailKey('partial@example.com'), afterOldExpired)).toBe(true);
  });
});
