// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';

// 「未完了のみ」絞り込み (?open=1) の正規化と条件組み立て (一覧 / ダッシュボード共通の単一の真実)
import {
  applyOpenFilter,
  OPEN_FILTER_VALUE,
  parseOpenParam,
} from '../src/features/tickets/open-filter';
// 未完了ステータス一覧 (期待値を書き写さず実装と同じ参照元から導出する。§6 一元管理)
import { COMPLETED_STATUSES, UNRESOLVED_STATUSES } from '../src/domain/ticket-status';
// 件数/一覧フィルタ型 (テストの base フィルタ作成に使う)
import type { TicketListFilter } from '../src/data/ports/ticket-repository';

// URL クエリ open の正規化ルール (決めた値に完全一致するときだけ採用) を守れているかのテスト
describe('parseOpenParam', () => {
  // 決めた値ちょうどのときだけ有効になること
  it('accepts only the exact opt-in value', () => {
    expect(parseOpenParam(OPEN_FILTER_VALUE)).toBe(true);
  });

  // 未指定・空文字・紛らわしい値はすべて「絞り込みなし」に倒れること
  // (URL は信頼できない入力なので、曖昧な綴りを勝手に汲み取らない §9)
  it('falls back to false for anything else', () => {
    expect(parseOpenParam(undefined)).toBe(false);
    expect(parseOpenParam('')).toBe(false);
    expect(parseOpenParam('0')).toBe(false);
    expect(parseOpenParam('true')).toBe(false); // 真偽値らしく見えても採用しない
    expect(parseOpenParam('01')).toBe(false); // 前置ゼロ付きも採用しない (完全一致のみ)
  });
});

// 「未完了のみ」条件の組み立てルール (= ワークロード件数と一覧の同一性の根拠) のテスト
describe('applyOpenFilter', () => {
  // base に状態条件が無いときは未完了ステータス一覧がそのまま条件になること
  it('sets statusIn to every unresolved status when no status condition exists', () => {
    // base は空 (担当者・全件想定)
    const base: TicketListFilter = {};
    // 「未完了のみ」条件を適用する
    const result = applyOpenFilter(base);
    // 未完了ステータスがそのまま条件になること
    expect(result.statusIn).toEqual(UNRESOLVED_STATUSES);
    // 終息ステータスは 1 つも含まれないこと (ワークロード集計の除外条件と同じ集合)
    for (const completed of COMPLETED_STATUSES) {
      expect(result.statusIn).not.toContain(completed);
    }
  });

  // 既に statusIn があるときは上書きせず積集合を取ること。
  // 上書きすると `?tab=mine&open=1` で片方の条件が黙って消える
  // (status と statusIn が上書きし合っていた不具合とまったく同じ形)
  it('intersects with an existing statusIn instead of overwriting it', () => {
    // 'mine' タブが立てるのと同じ状態条件を base に置く
    const base: TicketListFilter = { statusIn: ['Open', 'InProgress'] };
    // 「未完了のみ」条件を適用する
    const result = applyOpenFilter(base);
    // どちらも未完了なので積集合は base のまま (広がらないことが要点)
    expect(result.statusIn).toEqual(['Open', 'InProgress']);
  });

  // 積集合が空になる組み合わせは「0 件」を意味する空配列になること。
  // undefined (= 絞り込みなし) に倒すと、条件が厳しすぎて 0 件のはずが全件に化ける (fail-open)
  it('yields an empty statusIn when the intersection is empty', () => {
    // 終息ステータスだけを指す状態条件を base に置く
    const base: TicketListFilter = { statusIn: [...COMPLETED_STATUSES] };
    // 「未完了のみ」条件を適用する
    const result = applyOpenFilter(base);
    // 積集合は空 (undefined ではなく空配列であることが重要)
    expect(result.statusIn).toEqual([]);
  });

  // 他の条件を壊さず、base を破壊的に書き換えないこと (applyTabFilter / applyDueFilter と同じ契約)
  it('keeps other conditions and does not mutate the base filter', () => {
    // 担当者条件だけを持つ base を用意する
    const base: TicketListFilter = { assigneeId: 'user-1' };
    // 「未完了のみ」条件を適用する
    const result = applyOpenFilter(base);
    // 既存の条件はそのまま引き継がれること
    expect(result.assigneeId).toBe('user-1');
    // base 自身は書き換えられていないこと
    expect(base.statusIn).toBeUndefined();
  });
});
