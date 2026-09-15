// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';

// 状況の変更で外すべき絞り込みキーの判定 (タブ切替と同じ方針を共有する純粋関数)
import { filtersClearedByStatusChange } from '../src/features/tickets/build-filter';
// 「未完了のみ」絞り込みの URL キー (期待値を書き写さず実装と同じ参照元から導出する。§6)
import { OPEN_FILTER_PARAM } from '../src/features/tickets/open-filter';
// 終息 / 未完了ステータス一覧 (同じくドメインの唯一の参照元から導出する)
import { COMPLETED_STATUSES, UNRESOLVED_STATUSES } from '../src/domain/ticket-status';

// 「未完了であること」を前提にする絞り込みと、終息ステータスの組み合わせは
// 定義上必ず 0 件になる。その組み合わせを 1 クリックで作らせない規則のテスト
describe('filtersClearedByStatusChange', () => {
  // 終息ステータスを選んだときは、未完了前提の絞り込みをすべて外すこと
  it('clears every unresolved-implying filter when a completed status is chosen', () => {
    // 終息ステータス (解決済み / 完了) のそれぞれで同じ結果になること
    for (const completed of COMPLETED_STATUSES) {
      // 判定結果を取り出す
      const cleared = filtersClearedByStatusChange(completed);
      // 期限絞り込みが外れること (両アダプタが「終息状態でない」を必ず AND で積むため)
      expect(cleared).toContain('due');
      // 「未完了のみ」絞り込みも外れること (定義そのものが未完了ステータスの集合のため)
      expect(cleared).toContain(OPEN_FILTER_PARAM);
    }
  });

  // 未完了ステータスは矛盾しないので、何も外さないこと。
  // 矛盾しない組み合わせまで解除すると「指定した絞り込みが黙って消える」逆向きの問題になる
  it('clears nothing for statuses that do not conflict', () => {
    // 未完了ステータスのそれぞれで空配列が返ること
    for (const unresolved of UNRESOLVED_STATUSES) {
      expect(filtersClearedByStatusChange(unresolved)).toEqual([]);
    }
  });

  // 空文字 (= 絞り込み解除) や列挙外の値では何も外さないこと。
  // 絞り込み自体が適用されない値なので、他の絞り込みを巻き添えにする理由が無い
  it('clears nothing for values that are not applied as a status filter', () => {
    expect(filtersClearedByStatusChange('')).toEqual([]);
    expect(filtersClearedByStatusChange('resolved')).toEqual([]); // 大文字小文字違いは列挙外
    expect(filtersClearedByStatusChange('Unknown')).toEqual([]);
  });
});
