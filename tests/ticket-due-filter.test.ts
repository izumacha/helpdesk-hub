// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';

// 期限絞り込み (?due=...) の正規化と条件組み立て (一覧 / ダッシュボード共通の単一の真実)
import { applyDueFilter, parseDueParam, DUE_FILTER_LABELS } from '../src/features/tickets/due-filter';
// 件数/一覧フィルタ型 (テストの base フィルタ作成に使う)
import type { TicketListFilter } from '../src/data/ports/ticket-repository';

// テストで使う固定の現在時刻 (UTC 00:00 = JST 09:00。JST の「今日」は 2026-06-16)
const NOW = new Date('2026-06-16T00:00:00.000Z');
// NOW が属する JST の日の終端 (2026-06-16T23:59:59.999+09:00 = UTC では同日 14:59:59.999)
const END_OF_TODAY_JST = new Date('2026-06-16T14:59:59.999Z');

// URL クエリ due の正規化ルール (列挙外は無視する) を守れているかのテスト
describe('parseDueParam', () => {
  // 有効値 'soon' / 'today' はそのまま採用されること
  it('accepts the two known due ids', () => {
    expect(parseDueParam('soon')).toBe('soon');
    expect(parseDueParam('today')).toBe('today');
  });

  // 未指定・空文字・列挙外の値は「絞り込みなし」(undefined) になること
  it('falls back to undefined for unknown values', () => {
    expect(parseDueParam(undefined)).toBeUndefined();
    expect(parseDueParam('')).toBeUndefined();
    expect(parseDueParam('overdue')).toBeUndefined(); // タブ ID を紛れ込ませても採用しない
    expect(parseDueParam('SOON')).toBeUndefined(); // 大文字違いも採用しない (完全一致のみ)
  });
});

// 期限絞り込み条件の組み立てルール (= タイル件数と一覧の同一性の根拠) のテスト
describe('applyDueFilter', () => {
  // 'soon': 警告帯の基準時刻 now が dueSoon 条件として伝搬されること
  it('passes now to the dueSoon filter', () => {
    // base は空 (担当者・全件想定)
    const base: TicketListFilter = {};
    // 'soon' を適用
    const result = applyDueFilter(base, 'soon', { now: NOW });
    // dueSoon.now に基準時刻が入ること
    expect(result.dueSoon).toEqual({ now: NOW });
    // 'today' 用の条件は付かないこと
    expect(result.dueUntil).toBeUndefined();
  });

  // 'today': JST の「今日の終わり」が dueUntil 条件になること
  it('sets dueUntil to the end of today in JST', () => {
    // base は空
    const base: TicketListFilter = {};
    // 'today' を適用
    const result = applyDueFilter(base, 'today', { now: NOW });
    // dueUntil.until が JST の今日 23:59:59.999 になること
    expect(result.dueUntil?.until.getTime()).toBe(END_OF_TODAY_JST.getTime());
    // 'soon' 用の条件は付かないこと
    expect(result.dueSoon).toBeUndefined();
  });

  // 'today' の「今日」は UTC ではなく JST 基準であること
  // (UTC ではまだ前日 16:00 の時点でも、JST では既に 2026-06-16 に入っている)
  it('resolves today by JST even when the UTC date differs', () => {
    // UTC 2026-06-15 16:00 = JST 2026-06-16 01:00 (JST では NOW と同じ「今日」)
    const jstMidnightish = new Date('2026-06-15T16:00:00.000Z');
    // 'today' を適用
    const result = applyDueFilter({}, 'today', { now: jstMidnightish });
    // JST 基準の同じ「今日の終わり」になること
    expect(result.dueUntil?.until.getTime()).toBe(END_OF_TODAY_JST.getTime());
  });

  // base の条件 (RBAC の creatorId 等) を維持しつつ、破壊的に書き換えないこと
  it('preserves base conditions and does not mutate the base filter', () => {
    // 依頼者スコープ + 拠点絞り込みの base
    const base: TicketListFilter = { creatorId: 'u1', locationId: 'loc1' };
    // 'soon' を適用
    const result = applyDueFilter(base, 'soon', { now: NOW });
    // base の条件は維持されていること
    expect(result.creatorId).toBe('u1');
    expect(result.locationId).toBe('loc1');
    // base 側には期限条件が漏れていないこと (複製を返す)
    expect(base.dueSoon).toBeUndefined();
  });
});

// ラベル表が 2 つの絞り込み ID を網羅していることのテスト
// (Record<TicketDueId, string> なので追加漏れは typecheck が落とすが、
//  空文字ラベルの混入 = 画面のチップが無言になる事故はここで検出する)
describe('DUE_FILTER_LABELS', () => {
  it('has a non-empty Japanese label for every due id', () => {
    // 各ラベルが空でないこと
    expect(DUE_FILTER_LABELS.soon.length).toBeGreaterThan(0);
    expect(DUE_FILTER_LABELS.today.length).toBeGreaterThan(0);
  });
});
