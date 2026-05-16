// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';
// 検証対象 (YYYY-MM-DD → JST 終端 Date 変換ヘルパー)
import { endOfDayJST } from '@/lib/format-date';

// JST 終端 Date 変換の境界値テスト
describe('endOfDayJST', () => {
  // 正常な YYYY-MM-DD は JST 23:59:59.999 (= UTC 14:59:59.999) になる
  it('returns a Date at 23:59:59.999 JST (= 14:59:59.999 UTC)', () => {
    const d = endOfDayJST('2026-05-17');
    expect(d).not.toBeNull();
    // toISOString は UTC 表記で返るため、JST 23:59 は UTC 14:59 に対応
    expect(d!.toISOString()).toBe('2026-05-17T14:59:59.999Z');
  });

  // 形式不正 (区切り違い) は null を返す
  it('returns null for malformed date string', () => {
    expect(endOfDayJST('2026/05/17')).toBeNull();
    expect(endOfDayJST('2026-5-17')).toBeNull();
    expect(endOfDayJST('not-a-date')).toBeNull();
  });

  // 実在しない日付 (2 月 31 日) は null を返す
  // (JS の Date は不正値で NaN になるので endOfDayJST はそれを拾う)
  it('returns null for impossible calendar date', () => {
    const d = endOfDayJST('2026-02-31');
    // JS の Date(`2026-02-31T...`) は Invalid Date になるので null
    expect(d).toBeNull();
  });

  // 月の境界 (年末) も正しく扱える
  it('handles end-of-year correctly', () => {
    const d = endOfDayJST('2026-12-31');
    // JST 12/31 23:59:59 → UTC 12/31 14:59:59
    expect(d!.toISOString()).toBe('2026-12-31T14:59:59.999Z');
  });
});
