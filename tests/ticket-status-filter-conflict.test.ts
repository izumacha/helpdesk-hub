// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';

// 状況の変更 / タブの切替で外すべき絞り込みキーの判定 (2 つの入口で共有する純粋関数)
import {
  filtersClearedByStatusChange,
  filtersClearedByTabChange,
} from '../src/features/tickets/build-filter';
// 「未完了のみ」絞り込みの URL キー (期待値を書き写さず実装と同じ参照元から導出する。§6)
import { OPEN_FILTER_PARAM } from '../src/features/tickets/open-filter';
// 終息 / 未完了ステータス一覧 (同じくドメインの唯一の参照元から導出する)
import { COMPLETED_STATUSES, UNRESOLVED_STATUSES } from '../src/domain/ticket-status';

// 「必ず 0 件」になる組み合わせを 1 クリックで作らせない規則のテスト。
// 入口は 2 つ (状況ドロップダウン / タブ) あり、**どちらか片方だけ塞いでも意味が無い**ので
// 両方向を固定する
describe('filtersClearedByStatusChange', () => {
  // 終息ステータスを選んだときは、未完了前提の絞り込みをすべて外すこと
  it('clears every unresolved-implying filter when a completed status is chosen', () => {
    // 終息ステータス (解決済み / 完了) のそれぞれで同じ結果になること
    for (const completed of COMPLETED_STATUSES) {
      // タブ指定なし (= 'all') の状態で判定する
      const cleared = filtersClearedByStatusChange(completed, undefined);
      // 期限絞り込みが外れること (両アダプタが「終息状態でない」を必ず AND で積むため)
      expect(cleared).toContain('due');
      // 「未完了のみ」絞り込みも外れること (定義そのものが未完了ステータスの集合のため)
      expect(cleared).toContain(OPEN_FILTER_PARAM);
    }
  });

  // 'mine' タブが除く状態を選んだときは、タブも外すこと。
  // 'mine' は statusIn=['Open','InProgress'] なので、それ以外の状態との積は必ず空集合になる。
  // **終息ステータスに限らない** — New / WaitingForUser / Escalated も同じ行き止まりを作る
  it('clears the tab when the current tab always excludes the chosen status', () => {
    // 'mine' が残す 2 状態以外はすべてタブが外れること
    for (const status of ['New', 'WaitingForUser', 'Escalated', ...COMPLETED_STATUSES]) {
      expect(filtersClearedByStatusChange(status, 'mine')).toContain('tab');
    }
    // 'overdue' タブは終息状態を除くので、終息ステータスを選ぶとタブが外れること
    for (const completed of COMPLETED_STATUSES) {
      expect(filtersClearedByStatusChange(completed, 'overdue')).toContain('tab');
    }
  });

  // タブが残す状態を選んだときは、タブを外さないこと (矛盾しない組み合わせは触らない)
  it('keeps the tab when the chosen status is still inside the tab', () => {
    // 'mine' は Open / InProgress を残すので、そのままにすること
    expect(filtersClearedByStatusChange('Open', 'mine')).not.toContain('tab');
    expect(filtersClearedByStatusChange('InProgress', 'mine')).not.toContain('tab');
    // 'overdue' は未完了ならどの状態も残しうるので、そのままにすること
    expect(filtersClearedByStatusChange('New', 'overdue')).not.toContain('tab');
  });

  // 未完了ステータスは期限系と矛盾しないので、何も外さないこと。
  // 矛盾しない組み合わせまで解除すると「指定した絞り込みが黙って消える」逆向きの問題になる
  it('clears nothing for statuses that do not conflict with anything', () => {
    // タブ指定なしなら、未完了ステータスは何とも矛盾しない
    for (const unresolved of UNRESOLVED_STATUSES) {
      expect(filtersClearedByStatusChange(unresolved, undefined)).toEqual([]);
    }
  });

  // 空文字 (= 絞り込み解除) や列挙外の値では何も外さないこと。
  // 絞り込み自体が適用されない値なので、他の絞り込みを巻き添えにする理由が無い
  it('clears nothing for values that are not applied as a status filter', () => {
    expect(filtersClearedByStatusChange('', 'mine')).toEqual([]);
    expect(filtersClearedByStatusChange('resolved', 'mine')).toEqual([]); // 大文字小文字違いは列挙外
    expect(filtersClearedByStatusChange('Unknown', 'mine')).toEqual([]);
  });
});

// タブ側 (裏返しの入口)。状況ドロップダウン側だけ塞いでも、
// `?status=Resolved` の一覧でタブを押せば同じ行き止まりに落ちる
describe('filtersClearedByTabChange', () => {
  // 期限絞り込みは常に外すこと (タブと同じ期限軸のため。既存の挙動)
  it('always clears the due filter', () => {
    expect(filtersClearedByTabChange('all', undefined)).toContain('due');
    expect(filtersClearedByTabChange('mine', undefined)).toContain('due');
    expect(filtersClearedByTabChange('overdue', undefined)).toContain('due');
  });

  // 新しいタブが必ず除く状況が指定されていれば、その状況も外すこと
  it('clears the status filter when the new tab always excludes it', () => {
    // 'mine' タブは Open / InProgress 以外を除く
    expect(filtersClearedByTabChange('mine', 'Resolved')).toContain('status');
    expect(filtersClearedByTabChange('mine', 'New')).toContain('status');
    // 'overdue' タブは終息状態を除く
    for (const completed of COMPLETED_STATUSES) {
      expect(filtersClearedByTabChange('overdue', completed)).toContain('status');
    }
  });

  // 矛盾しない状況・読めない値・未指定では、状況を外さないこと
  it('keeps the status filter when it does not conflict', () => {
    expect(filtersClearedByTabChange('mine', 'Open')).not.toContain('status');
    expect(filtersClearedByTabChange('overdue', 'New')).not.toContain('status');
    expect(filtersClearedByTabChange('all', 'Resolved')).not.toContain('status');
    expect(filtersClearedByTabChange('mine', 'Unknown')).not.toContain('status');
    expect(filtersClearedByTabChange('mine', undefined)).not.toContain('status');
  });
});
