// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';
// 検証対象 (YYYY-MM-DD → JST 終端 Date 変換ヘルパー / JST 月初計算ヘルパー / JST ISO日付整形ヘルパー)
import { endOfDayJST, startOfMonthJST, formatDateISO } from '@/lib/format-date';

// フォローアップ (2026-07-11 #2): CSV エクスポートの期限日を再インポート可能な 'YYYY-MM-DD' に
// 整形するヘルパーの回帰テスト (endOfDayJST の逆変換に相当)
describe('formatDateISO', () => {
  // 通常の日付は 'YYYY-MM-DD' (ゼロ埋め済み) になる
  it('returns zero-padded YYYY-MM-DD in JST', () => {
    // 2026-03-05 10:00 UTC = 2026-03-05 19:00 JST
    expect(formatDateISO(new Date('2026-03-05T10:00:00.000Z'))).toBe('2026-03-05');
  });

  // 月・日が1桁の場合もゼロ埋めされる (formatDateJP のような '2026/3/5' にはならない)
  it('zero-pads single-digit month and day', () => {
    // 2026-01-09 00:30 UTC = 2026-01-09 09:30 JST
    expect(formatDateISO(new Date('2026-01-09T00:30:00.000Z'))).toBe('2026-01-09');
  });

  // UTC 日付をまたいで JST 側の日付が繰り上がるケース (endOfDayJST の逆変換と整合すること)
  it('round-trips with endOfDayJST for a JST date boundary', () => {
    const jstDate = endOfDayJST('2026-05-17')!;
    expect(formatDateISO(jstDate)).toBe('2026-05-17');
  });
});

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

// JST 月初計算の境界値テスト (月間チケット上限の集計基準)
describe('startOfMonthJST', () => {
  // UTC で見ると前日 (5/31) の午後だが、JST では 6/1 になっている時刻。
  // Date.UTC ベースの旧実装だとここで月初が 1 ヶ月分ずれていた (5/1 のまま)。
  it('resolves to the JST month even when UTC is still in the previous month', () => {
    // 2026-06-01 00:30 JST = 2026-05-31 15:30 UTC
    const jstJustAfterMidnight = new Date('2026-05-31T15:30:00.000Z');
    const start = startOfMonthJST(jstJustAfterMidnight);
    // JST 6/1 00:00:00.000 = UTC 5/31 15:00:00.000
    expect(start.toISOString()).toBe('2026-05-31T15:00:00.000Z');
  });

  // UTC で見ると翌日 (6/1) の午前だが、JST ではまだ 5/31 のうち (=5月扱い) の時刻。
  it('resolves to the JST month even when UTC has already rolled over to the next month', () => {
    // 2026-05-31 23:30 JST = 2026-05-31 14:30 UTC
    const stillMayInJst = new Date('2026-05-31T14:30:00.000Z');
    const start = startOfMonthJST(stillMayInJst);
    // JST 5/1 00:00:00.000 = UTC 4/30 15:00:00.000
    expect(start.toISOString()).toBe('2026-04-30T15:00:00.000Z');
  });

  // 年をまたぐ場合 (JST 1/1 直後) も正しく年初月初になる
  it('handles the year boundary correctly', () => {
    // 2027-01-01 00:30 JST = 2026-12-31 15:30 UTC
    const jstNewYear = new Date('2026-12-31T15:30:00.000Z');
    const start = startOfMonthJST(jstNewYear);
    // JST 2027-01-01 00:00:00.000 = UTC 2026-12-31 15:00:00.000
    expect(start.toISOString()).toBe('2026-12-31T15:00:00.000Z');
  });

  // 引数省略時は現在時刻を基準にする (例外を投げず Date を返すことだけ確認)
  it('defaults to the current time when no argument is given', () => {
    expect(() => startOfMonthJST()).not.toThrow();
    expect(startOfMonthJST()).toBeInstanceOf(Date);
  });
});
