// Vitest のテスト DSL (フック/グルーピング/期待値/個別テスト)
import { beforeEach, describe, expect, it } from 'vitest';

// レート制限の本体と、テスト用に内部状態をリセット/参照する関数
import {
  __resetRateLimits,
  __getRateLimitBucketCount,
  enforceRateLimit,
  checkRateLimit,
} from '../src/lib/rate-limit';

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

  // メモリリーク修正: チケット ID を含む使い捨てキー (ticket-status:user:ticket 等) が
  // 二度と呼ばれなくても、後続の別呼び出しに便乗した掃除で Map から削除されること
  it('removes fully-expired one-off keys from the internal map (no unbounded growth)', () => {
    const t0 = 1_000_000;
    // "ticket-status:u1:ticket-1" のような、二度と呼ばれない使い捨てキーを 1 回だけ使う
    enforceRateLimit('ticket-status:u1:ticket-1', { limit: 10, windowMs: 10_000 }, t0);
    // この時点ではまだ窓内なので Map にエントリが残っている
    expect(__getRateLimitBucketCount()).toBe(1);

    // 窓 (10 秒) より十分先に進めてから、別のキーで呼び出す
    // (このライブラリには cron が無いので、他キーの呼び出しに便乗して掃除される設計)
    enforceRateLimit('ticket-status:u2:ticket-2', { limit: 10, windowMs: 10_000 }, t0 + 20_000);

    // 先に使った使い捨てキーは完全に期限切れになっているので削除され、
    // 直近呼び出し分の 1 件だけが残る (2 件のまま溜まり続けない)
    expect(__getRateLimitBucketCount()).toBe(1);
  });

  // 同じキーを繰り返し使う通常の利用パターンでは、窓内である限りエントリが保持される
  it('keeps a key alive while it is still within its own window', () => {
    const t0 = 1_000_000;
    enforceRateLimit('ticket-comment:u1', { limit: 5, windowMs: 60_000 }, t0);
    // 窓 (60 秒) の途中で他キーを呼んでも、まだ生きているキーは消えない
    enforceRateLimit('other-key', { limit: 5, windowMs: 60_000 }, t0 + 5_000);
    expect(__getRateLimitBucketCount()).toBe(2);
  });
});

// checkRateLimit (throw せず {error} を返す契約のアクション向けラッパー) の仕様確認テスト群
describe('checkRateLimit', () => {
  beforeEach(() => {
    __resetRateLimits();
  });

  // 上限以内なら null (エラー無し) を返す
  it('returns null when within the limit', () => {
    const now = 1_000_000;
    expect(checkRateLimit('k', { limit: 3, windowMs: 10_000 }, now)).toBeNull();
  });

  // 上限を超えると enforceRateLimit と同じ日本語メッセージを文字列で返す (例外を投げない)
  it('returns the Japanese message string instead of throwing once over the limit', () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      expect(checkRateLimit('k', { limit: 3, windowMs: 10_000 }, now + i)).toBeNull();
    }
    const message = checkRateLimit('k', { limit: 3, windowMs: 10_000 }, now + 4);
    expect(message).toEqual(expect.stringMatching(/操作の頻度/));
  });
});
