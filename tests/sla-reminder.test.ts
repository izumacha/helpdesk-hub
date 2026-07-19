// Vitest のテスト DSL
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// テスト対象 (純粋ヘルパー)
import { needsSlaDueSoonReminder, renderSlaDueSoonMessage } from '@/lib/sla-reminder';

// DEFAULT_WARNING_THRESHOLD_MS (24時間) を意識したテスト用の基準時刻とオフセット。
// needsSlaDueSoonReminder は内部で getSlaState (src/lib/sla.ts) 経由で `new Date()` を
// 参照するため、テスト側の基準時刻と実際の `new Date()` を一致させる必要がある。
// vi.setSystemTime でシステム時刻ごと固定することでこれを保証する
const NOW = new Date('2026-07-19T00:00:00Z');
const HOUR_MS = 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// needsSlaDueSoonReminder のテストで共通に使う「素直な候補」を組み立てるヘルパー。
// 個々のテストは差分のみ上書きする
function candidate(overrides: Partial<Parameters<typeof needsSlaDueSoonReminder>[0]> = {}) {
  return {
    resolutionDueAt: new Date(NOW.getTime() + 12 * HOUR_MS), // 残り12時間 (24時間窓の warning に該当)
    resolvedAt: null,
    assigneeId: 'agent-1',
    slaReminderNotifiedForDueAt: null,
    ...overrides,
  };
}

describe('needsSlaDueSoonReminder', () => {
  // 警告帯 (残り24時間以内・未超過) かつ担当者ありかつ未通知なら true
  it('警告帯・担当者あり・未通知なら true を返す', () => {
    expect(needsSlaDueSoonReminder(candidate())).toBe(true);
  });

  // まだ警告帯に入っていない (残り時間が長い) なら false ('ok' 状態)
  it('警告帯に入っていなければ false を返す', () => {
    const c = candidate({ resolutionDueAt: new Date(NOW.getTime() + 48 * HOUR_MS) });
    expect(needsSlaDueSoonReminder(c)).toBe(false);
  });

  // 既に期限超過 ('overdue' 状態) なら false (超過は一覧・詳細のバッジで既に警告済みのため対象外)
  it('期限超過は false を返す (バッジで既に警告済みのため対象外)', () => {
    const c = candidate({ resolutionDueAt: new Date(NOW.getTime() - HOUR_MS) });
    expect(needsSlaDueSoonReminder(c)).toBe(false);
  });

  // 期限未設定 ('none' 状態) なら false
  it('期限未設定なら false を返す', () => {
    const c = candidate({ resolutionDueAt: null });
    expect(needsSlaDueSoonReminder(c)).toBe(false);
  });

  // 既に解決済み ('ok' 状態) なら false
  it('解決済みなら false を返す', () => {
    const c = candidate({ resolvedAt: new Date(NOW.getTime() - HOUR_MS) });
    expect(needsSlaDueSoonReminder(c)).toBe(false);
  });

  // 担当者未アサインなら通知先が無いので false
  it('担当者未アサインなら false を返す', () => {
    const c = candidate({ assigneeId: null });
    expect(needsSlaDueSoonReminder(c)).toBe(false);
  });

  // 同じ resolutionDueAt に対して既に通知済みなら再送しない (二重送信防止)
  it('同じ期限に既に通知済みなら false を返す', () => {
    const dueAt = new Date(NOW.getTime() + 12 * HOUR_MS);
    const c = candidate({ resolutionDueAt: dueAt, slaReminderNotifiedForDueAt: dueAt });
    expect(needsSlaDueSoonReminder(c)).toBe(false);
  });

  // 過去に別の (古い) 期限に対して通知済みでも、期限が変わっていれば再アームされ true を返す
  // (優先度変更等で resolutionDueAt が再計算されたケースを想定。取りこぼし防止)
  it('通知済みの期限と現在の期限が異なれば再アームされ true を返す', () => {
    const oldDueAt = new Date(NOW.getTime() + 48 * HOUR_MS); // 以前は余裕があった期限
    const newDueAt = new Date(NOW.getTime() + 12 * HOUR_MS); // 優先度変更等で前倒しされた期限
    const c = candidate({ resolutionDueAt: newDueAt, slaReminderNotifiedForDueAt: oldDueAt });
    expect(needsSlaDueSoonReminder(c)).toBe(true);
  });
});

describe('renderSlaDueSoonMessage', () => {
  // 件名を含む通知文言を組み立てること
  it('チケット件名を含む通知文言を返す', () => {
    const message = renderSlaDueSoonMessage('サーバーが応答しない');
    expect(message).toContain('サーバーが応答しない');
    expect(message).toContain('解決期限');
  });
});
