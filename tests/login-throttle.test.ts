// Vitest のテスト DSL (フック/グルーピング/期待値/個別テスト)
import { beforeEach, describe, expect, it } from 'vitest';

// ログイン失敗スロットルの本体と、テスト用に内部状態をリセットする関数
import {
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
});
