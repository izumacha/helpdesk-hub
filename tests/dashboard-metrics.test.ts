// ダッシュボード品質指標の「直近 N 日」窓の起点計算と、キャッシュ配線の回帰テスト。
//
// /code-review ultra 指摘対応 (2026-09-09): 本フォローアップは qualityMetrics へ `since` を
// 渡す初めての呼び出し元であり、窓の起点計算 (JST 丸め・日数の算術) が 1 日ずれても
// 型検査は緑のまま通る。純粋な計算部分をここで固定する
// (実 DB 側の since 絞り込みは tests/data/ticket-repository.contract.ts が担う)。

// Vitest のテスト DSL (vi は next/cache のモックに使う)
import { describe, expect, it, vi } from 'vitest';

// next/cache をモックする (実際のキャッシュ機構は起動せず、素通しさせる。
// notifications-cache.test.ts と同じパターン)
vi.mock('next/cache', () => ({
  // unstable_cache は渡された関数をそのまま返すだけにする (計算結果の検証が目的のため)
  unstable_cache: (fn: unknown) => fn,
}));

// 検証対象 (モック宣言の後に import する必要があるため下に置く)
import { qualityMetricsSince, QUALITY_METRICS_WINDOW_DAYS } from '@/lib/dashboard-metrics';

// 1 日をミリ秒で表した定数 (検証側の期間計算用)
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// 「直近 N 日 (今日を含む)」の起点計算のテスト
describe('qualityMetricsSince', () => {
  // 起点は「JST の今日の始まり − (N−1) 日」= 今日を含む N 日窓の初日 00:00 (JST) になること
  it('returns the start of the JST day (window days - 1) days ago', () => {
    // UTC 2026-06-16 00:00 = JST 2026-06-16 09:00 → JST の今日の始まりは UTC 06-15 15:00
    const now = new Date('2026-06-16T00:00:00.000Z');
    const since = qualityMetricsSince(now);
    // 今日の始まり (UTC 06-15 15:00) から (N-1) 日戻った時刻であること
    const expected = new Date(
      new Date('2026-06-15T15:00:00.000Z').getTime() - (QUALITY_METRICS_WINDOW_DAYS - 1) * ONE_DAY_MS,
    );
    expect(since.toISOString()).toBe(expected.toISOString());
  });

  // 同じ JST の日の中では時刻が違っても起点が変わらないこと
  // (キャッシュキーが日単位で安定する = unstable_cache が効く前提の検証)
  it('is stable within the same JST day so the cache key does not churn', () => {
    // JST 2026-06-16 の朝と深夜 (どちらも同じ JST の日に属する)
    const morning = qualityMetricsSince(new Date('2026-06-16T00:00:00.000Z')); // JST 09:00
    const night = qualityMetricsSince(new Date('2026-06-16T14:00:00.000Z')); // JST 23:00
    expect(morning.getTime()).toBe(night.getTime());
  });

  // JST で日付が変わった瞬間に起点も 1 日進むこと (窓が固定されず動き続ける = 凍結しない)
  it('advances by one day when the JST date rolls over', () => {
    // JST 2026-06-16 23:00 と JST 2026-06-17 00:00 (UTC では同日 15:00)
    const beforeMidnight = qualityMetricsSince(new Date('2026-06-16T14:00:00.000Z'));
    const afterMidnight = qualityMetricsSince(new Date('2026-06-16T15:00:00.000Z'));
    expect(afterMidnight.getTime() - beforeMidnight.getTime()).toBe(ONE_DAY_MS);
  });
});
