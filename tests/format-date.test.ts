// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';
// 検証対象 (YYYY-MM-DD → JST 終端 Date 変換ヘルパー / JST 月初計算ヘルパー / JST ISO日付整形ヘルパー /
// フォローアップ 2026-07-15 #3: CSV「起票日時」列の往復用フォーマッタ・パーサ)
import {
  endOfDayJST,
  startOfMonthJST,
  formatDateISO,
  formatDateTimeISO,
  parseDateTimeJST,
} from '@/lib/format-date';

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

// フォローアップ (2026-07-15 #3): CSV エクスポートの「起票日時」を再インポート可能な
// 'YYYY-MM-DD HH:mm:ss' に整形するヘルパーの回帰テスト (parseDateTimeJST の逆変換に相当)
describe('formatDateTimeISO', () => {
  // 通常の日時は 'YYYY-MM-DD HH:mm:ss' (ゼロ埋め済み・24 時間表記) になる
  it('returns zero-padded YYYY-MM-DD HH:mm:ss in JST', () => {
    // 2026-03-05 01:02:03 UTC = 2026-03-05 10:02:03 JST
    expect(formatDateTimeISO(new Date('2026-03-05T01:02:03.000Z'))).toBe('2026-03-05 10:02:03');
  });

  // 時分秒が1桁の場合もゼロ埋めされる (formatDateTimeJP のような '2026/1/9 0:30:05' にはならない)
  it('zero-pads single-digit month/day/hour/minute/second', () => {
    // 2026-01-08 15:30:05 UTC = 2026-01-09 00:30:05 JST
    expect(formatDateTimeISO(new Date('2026-01-08T15:30:05.000Z'))).toBe('2026-01-09 00:30:05');
  });

  // 正午をまたいでも 24 時間表記 (h23) で AM/PM が混入しないこと
  it('uses 24-hour notation without AM/PM', () => {
    // 2026-06-15 03:00:00 UTC = 2026-06-15 12:00:00 JST (正午)
    expect(formatDateTimeISO(new Date('2026-06-15T03:00:00.000Z'))).toBe('2026-06-15 12:00:00');
    // 2026-06-15 15:00:00 UTC = 2026-06-16 00:00:00 JST (深夜0時)
    expect(formatDateTimeISO(new Date('2026-06-15T15:00:00.000Z'))).toBe('2026-06-16 00:00:00');
  });
});

// 'YYYY-MM-DD HH:mm:ss' → JST Date 変換の境界値テスト (formatDateTimeISO と往復すること)
describe('parseDateTimeJST', () => {
  // formatDateTimeISO の出力をそのまま再パースすると同じ時刻に戻ること (往復性)
  it('round-trips with formatDateTimeISO', () => {
    const original = new Date('2026-03-05T01:02:03.000Z');
    const formatted = formatDateTimeISO(original);
    const parsed = parseDateTimeJST(formatted);
    expect(parsed).not.toBeNull();
    expect(parsed!.getTime()).toBe(original.getTime());
  });

  // 形式不正 (区切り違い・秒欠落等) は null を返す
  it('returns null for malformed datetime strings', () => {
    expect(parseDateTimeJST('2026/03/05 10:02:03')).toBeNull();
    expect(parseDateTimeJST('2026-03-05T10:02:03')).toBeNull(); // 'T' 区切りは不可 (半角スペース必須)
    expect(parseDateTimeJST('2026-03-05 10:02')).toBeNull(); // 秒が無い
    expect(parseDateTimeJST('not-a-datetime')).toBeNull();
  });

  // 実在しない日時 (2 月 31 日) は null を返す (endOfDayJST と同じロールオーバー検知)
  it('returns null for an impossible calendar date', () => {
    expect(parseDateTimeJST('2026-02-31 10:00:00')).toBeNull();
  });

  // 存在しない時刻 (25 時) も null を返す (ロールオーバーで翌日 1 時になるのを弾く)
  it('returns null for an impossible time of day', () => {
    expect(parseDateTimeJST('2026-03-05 25:00:00')).toBeNull();
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
