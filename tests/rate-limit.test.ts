// Vitest のテスト DSL (フック/グルーピング/期待値/個別テスト)
import { beforeEach, describe, expect, it } from 'vitest';

// レート制限の本体と、テスト用に内部状態をリセットする関数
import { __resetRateLimits, enforceRateLimit } from '../src/lib/rate-limit';

// レート制限ヘルパーの仕様確認テスト群
describe('enforceRateLimit', () => {
  // 各テストの前に履歴をクリアしてテスト間の独立を保つ
  beforeEach(() => {
    __resetRateLimits();
  });

  // 上限以内の連続呼び出しは許される
  it('allows calls up to the limit within the window', () => {
    // 基準時刻 (固定値で再現性確保)
    const now = 1_000_000;
    // 上限 3 回 / 10 秒の設定で 3 回呼び出し、いずれも例外を投げないこと
    for (let i = 0; i < 3; i += 1) {
      expect(() => enforceRateLimit('k', { limit: 3, windowMs: 10_000 }, now + i)).not.toThrow();
    }
  });

  // 上限を超えた次の呼び出しで日本語の例外が投げられる
  it('rejects the next call beyond the limit with a Japanese message', () => {
    const now = 1_000_000;
    // まず 3 回呼んで上限まで使い切る
    for (let i = 0; i < 3; i += 1) {
      enforceRateLimit('k', { limit: 3, windowMs: 10_000 }, now + i);
    }
    // 4 回目は「操作の頻度」を含む日本語エラーで拒否される
    expect(() => enforceRateLimit('k', { limit: 3, windowMs: 10_000 }, now + 4)).toThrow(
      /操作の頻度/,
    );
  });

  // ウィンドウから古い記録が抜ければ再び呼び出せる
  it('allows calls again once the oldest entry ages out of the window', () => {
    const t0 = 1_000_000;
    // 3 回連続で上限を使う
    for (let i = 0; i < 3; i += 1) {
      enforceRateLimit('k', { limit: 3, windowMs: 10_000 }, t0 + i);
    }
    // 最初の呼び出しからウィンドウを超える時刻まで進めて再呼び出し
    expect(() => enforceRateLimit('k', { limit: 3, windowMs: 10_000 }, t0 + 10_001)).not.toThrow();
  });

  // 異なるキー (=ユーザー) は別カウントで管理されること
  it('tracks keys independently', () => {
    const now = 1_000_000;
    // user-a 側で上限を使い切る
    for (let i = 0; i < 3; i += 1) {
      enforceRateLimit('user-a', { limit: 3, windowMs: 10_000 }, now + i);
    }
    // user-b 側はカウントが別なので呼び出し可能
    expect(() => enforceRateLimit('user-b', { limit: 3, windowMs: 10_000 }, now)).not.toThrow();
  });
});
