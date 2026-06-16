// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';

// 一覧タブの絞り込み条件を組み立てる純粋関数 (一覧ページ / Lite ダッシュボード共通)
import { applyTabFilter } from '../src/features/tickets/tab-filter';
// 件数/一覧フィルタ型 (テストの base フィルタ作成に使う)
import type { TicketListFilter } from '../src/data/ports/ticket-repository';

// テストで使う固定の現在時刻 (overdue 判定の基準が伝搬されることの確認用)
const NOW = new Date('2026-06-16T00:00:00.000Z');

// タブ別フィルタ生成のルール (= 一覧/ダッシュボードで共有する単一の真実) を守れているかのテスト
describe('applyTabFilter', () => {
  // 'all' タブは追加条件を付けず base をそのまま (複製で) 返すこと
  it('returns base unchanged for the all tab', () => {
    // 起票者で絞った base フィルタ
    const base: TicketListFilter = { creatorId: 'u1' };
    // 'all' タブを適用
    const result = applyTabFilter(base, 'all', { isAgent: true, userId: 'u1', now: NOW });
    // タブ固有条件が一切付いていないこと
    expect(result.statusIn).toBeUndefined();
    expect(result.overdue).toBeUndefined();
    // base の条件は維持されていること
    expect(result.creatorId).toBe('u1');
  });

  // 'mine' タブ (担当者): 未対応 2 値 + 自分が担当 の条件が付くこと
  it('scopes mine tab to own assignments for agents', () => {
    // 担当者は creatorId 未指定 (全件) の base
    const base: TicketListFilter = { creatorId: undefined };
    // 'mine' タブを担当者として適用
    const result = applyTabFilter(base, 'mine', { isAgent: true, userId: 'agent1', now: NOW });
    // 未対応 (Open / InProgress) に限定されること
    expect(result.statusIn).toEqual(['Open', 'InProgress']);
    // 担当者は「担当が自分」で絞られること
    expect(result.assigneeId).toBe('agent1');
  });

  // 'mine' タブ (依頼者): 未対応 2 値のみで、担当者条件は付かないこと
  it('scopes mine tab by status only for requesters', () => {
    // 依頼者は creatorId = 自分 の base (呼び出し側で設定済みの想定)
    const base: TicketListFilter = { creatorId: 'requester1' };
    // 'mine' タブを依頼者として適用
    const result = applyTabFilter(base, 'mine', { isAgent: false, userId: 'requester1', now: NOW });
    // 未対応に限定されること
    expect(result.statusIn).toEqual(['Open', 'InProgress']);
    // 依頼者には担当者条件を付けない (creatorId で既に自分のチケットに絞られている)
    expect(result.assigneeId).toBeUndefined();
    // creatorId は維持されていること
    expect(result.creatorId).toBe('requester1');
  });

  // 'overdue' タブ: 期限超過判定の基準時刻 now が伝搬されること
  it('passes now to the overdue filter', () => {
    // base は空 (担当者・全件想定)
    const base: TicketListFilter = {};
    // 'overdue' タブを適用
    const result = applyTabFilter(base, 'overdue', { isAgent: true, userId: 'agent1', now: NOW });
    // overdue.now に基準時刻が入ること
    expect(result.overdue).toEqual({ now: NOW });
    // 未対応条件 (statusIn) は付かないこと
    expect(result.statusIn).toBeUndefined();
  });

  // 呼び出し元の base を破壊的に書き換えないこと (複製を返す)
  it('does not mutate the base filter', () => {
    // 元の base
    const base: TicketListFilter = { creatorId: 'u1' };
    // 'mine' タブを適用
    applyTabFilter(base, 'mine', { isAgent: true, userId: 'u1', now: NOW });
    // base 側にはタブ条件が漏れていないこと
    expect(base.statusIn).toBeUndefined();
    expect(base.assigneeId).toBeUndefined();
  });
});
