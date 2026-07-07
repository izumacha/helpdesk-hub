// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';
// SLA 計算/状態判定/優先度ごとの解決時間・初回応答時間テーブル
import {
  calculateFirstResponseDueAt,
  calculateResolutionDueAt,
  getSlaState,
  FIRST_RESPONSE_HOURS_BY_PRIORITY,
  SLA_RESOLUTION_HOURS_BY_PRIORITY,
} from '../src/lib/sla';

// 期限算出関数のテスト
describe('calculateResolutionDueAt', () => {
  // 起点時刻 (固定して時差ぶれを避ける)
  const base = new Date('2026-04-17T00:00:00Z');

  // High は 24 時間後を返す
  it('adds 24 hours for High priority', () => {
    const due = calculateResolutionDueAt('High', base);
    expect(due.getTime() - base.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  // Medium は 72 時間後を返す
  it('adds 72 hours for Medium priority', () => {
    const due = calculateResolutionDueAt('Medium', base);
    expect(due.getTime() - base.getTime()).toBe(72 * 60 * 60 * 1000);
  });

  // Low は 168 時間 (= 7 日) 後を返す
  it('adds 168 hours (7 days) for Low priority', () => {
    const due = calculateResolutionDueAt('Low', base);
    expect(due.getTime() - base.getTime()).toBe(168 * 60 * 60 * 1000);
  });

  // 公開テーブルの値が期待通りに揃っていること
  it('exposes the hours table for each priority', () => {
    expect(SLA_RESOLUTION_HOURS_BY_PRIORITY.High).toBe(24);
    expect(SLA_RESOLUTION_HOURS_BY_PRIORITY.Medium).toBe(72);
    expect(SLA_RESOLUTION_HOURS_BY_PRIORITY.Low).toBe(168);
  });
});

// 初回応答期限算出関数のテスト (回帰防止: firstResponseDueAt が常に null のまま
// 起票される不備が過去にあったため、計算関数自体の正しさを固定する)
describe('calculateFirstResponseDueAt', () => {
  // 起点時刻 (固定して時差ぶれを避ける)
  const base = new Date('2026-04-17T00:00:00Z');

  // High は 4 時間後を返す
  it('adds 4 hours for High priority', () => {
    const due = calculateFirstResponseDueAt('High', base);
    expect(due.getTime() - base.getTime()).toBe(4 * 60 * 60 * 1000);
  });

  // Medium は 8 時間後を返す
  it('adds 8 hours for Medium priority', () => {
    const due = calculateFirstResponseDueAt('Medium', base);
    expect(due.getTime() - base.getTime()).toBe(8 * 60 * 60 * 1000);
  });

  // Low は 24 時間後を返す
  it('adds 24 hours for Low priority', () => {
    const due = calculateFirstResponseDueAt('Low', base);
    expect(due.getTime() - base.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  // 公開テーブルの値が期待通りに揃っていること
  it('exposes the hours table for each priority', () => {
    expect(FIRST_RESPONSE_HOURS_BY_PRIORITY.High).toBe(4);
    expect(FIRST_RESPONSE_HOURS_BY_PRIORITY.Medium).toBe(8);
    expect(FIRST_RESPONSE_HOURS_BY_PRIORITY.Low).toBe(24);
  });
});

// SLA 状態判定 (none/ok/warning/overdue) のテスト
describe('getSlaState', () => {
  // 現在時刻と、その前後の代表的な時刻を作る
  const now = new Date();
  // 2 時間前 (= 期限超過の代表)
  const past = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  // 10 時間後 (= 24 時間以内 = warning)
  const soon = new Date(now.getTime() + 10 * 60 * 60 * 1000);
  // 3 日後 (= 余裕あり = ok)
  const future = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  // 期限が未設定なら "none"
  it('returns "none" when no resolutionDueAt is set', () => {
    expect(getSlaState(null, null)).toBe('none');
  });

  // 解決済みなら期限超過していても "ok" 扱い
  it('returns "ok" when ticket is already resolved', () => {
    expect(getSlaState(past, now)).toBe('ok');
  });

  // 期限超過 + 未解決は "overdue"
  it('returns "overdue" when deadline has passed and not resolved', () => {
    expect(getSlaState(past, null)).toBe('overdue');
  });

  // 24 時間以内かつ未解決は "warning"
  it('returns "warning" when deadline is within 24 hours and not resolved', () => {
    expect(getSlaState(soon, null)).toBe('warning');
  });

  // 24 時間以上先 + 未解決は "ok"
  it('returns "ok" when deadline is more than 24 hours away and not resolved', () => {
    expect(getSlaState(future, null)).toBe('ok');
  });

  // 回帰防止: 初回応答期限のように窓が短い SLA では、既定の 24 時間閾値をそのまま
  // 使うと起票直後から常に warning になってしまう。warningThresholdMs を明示的に
  // 渡すことで、窓の長さに応じた適切な閾値で判定できること
  describe('warningThresholdMs (第3引数)', () => {
    // High 優先度の初回応答期限 (4 時間窓) を想定: 窓の 25% = 1 時間
    const highFirstResponseThresholdMs = 1 * 60 * 60 * 1000;

    // 残り 3 時間 (閾値 1 時間より外) は "ok" (既定の 24 時間閾値なら誤って warning になる)
    it('returns "ok" when remaining time exceeds the given threshold even if within 24 hours', () => {
      const in3Hours = new Date(now.getTime() + 3 * 60 * 60 * 1000);
      expect(getSlaState(in3Hours, null, highFirstResponseThresholdMs)).toBe('ok');
    });

    // 残り 30 分 (閾値 1 時間未満) は "warning"
    it('returns "warning" when remaining time is within the given threshold', () => {
      const in30Min = new Date(now.getTime() + 30 * 60 * 1000);
      expect(getSlaState(in30Min, null, highFirstResponseThresholdMs)).toBe('warning');
    });

    // 第3引数を省略した場合は従来どおり既定の 24 時間閾値が使われる (後方互換)
    it('defaults to the 24-hour threshold when warningThresholdMs is omitted', () => {
      expect(getSlaState(soon, null)).toBe('warning');
    });
  });
});
