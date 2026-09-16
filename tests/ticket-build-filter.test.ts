// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';

// URL クエリ → TicketListFilter の組み立て (一覧ページと CSV エクスポートが共有する唯一の入口)
import { buildTicketListFilter } from '../src/features/tickets/build-filter';
// 未完了ステータス一覧 (期待値を書き写さず実装と同じ参照元から導出する。§6 一元管理)
import { UNRESOLVED_STATUSES } from '../src/domain/ticket-status';
// 優先度ごとの SLA 時間表。アプリ内で唯一の Record<Priority, …> で、
// 「存在する優先度の一覧」を型で強制している宣言 (build-filter の導出元と同じ)
import { SLA_RESOLUTION_HOURS_BY_PRIORITY } from '../src/lib/sla';

// /code-review ultra 指摘対応 (2026-09-15): 個々のヘルパー (applyOpenFilter /
// parseOpenParam / applyTabFilter / applyDueFilter) には単体テストがあるのに、
// **それらを組み合わせる buildTicketListFilter には 1 件も無かった**。
// 実測: `?open=1` を適用する行を潰しても全 141 ファイル・1554 件が緑のまま通り、
// ダッシュボードのワークロード行が本 PR 以前のバグ (件数と一覧の不一致) に戻った。
// 組み立ての配線そのものをここで固定する。

// テストで使う固定の現在時刻 (期限条件の基準)
const NOW = new Date('2026-06-16T00:00:00.000Z');
// 担当者ロールの実行コンテキスト (RBAC の creatorId が付かない側)
const AGENT_CTX = { isAgent: true, userId: 'agent-1', now: NOW };
// 依頼者ロールの実行コンテキスト (RBAC の creatorId が必ず付く側)
const REQUESTER_CTX = { isAgent: false, userId: 'user-1', now: NOW };

describe('buildTicketListFilter', () => {
  // ?open=1 が「未完了のみ」条件として実際に組み立て結果へ届くこと
  it('applies the open filter when ?open=1 is present', () => {
    // 担当者として ?open=1 だけを指定する
    const filter = buildTicketListFilter({ open: '1' }, AGENT_CTX);
    // 未完了ステータスの一覧がそのまま状態条件になること
    expect(filter.statusIn).toEqual([...UNRESOLVED_STATUSES]);
  });

  // ?open が無い / 値が違うときは状態条件を足さないこと
  it('does not apply the open filter for a missing or unknown value', () => {
    expect(buildTicketListFilter({}, AGENT_CTX).statusIn).toBeUndefined();
    expect(buildTicketListFilter({ open: '0' }, AGENT_CTX).statusIn).toBeUndefined();
    expect(buildTicketListFilter({ open: 'true' }, AGENT_CTX).statusIn).toBeUndefined();
  });

  // タブと「未完了のみ」を同時に指定しても、どちらの条件も消えないこと。
  // 上書きだと 'mine' の 2 状態か未完了 5 状態のどちらかが黙って消える
  it('intersects the tab and open conditions instead of overwriting either', () => {
    // 'mine' タブ + 「未完了のみ」を同時に指定する
    const filter = buildTicketListFilter({ tab: 'mine', open: '1' }, AGENT_CTX);
    // 'mine' が立てる 2 状態が残ること (未完了の一覧に広がっていないこと)
    expect(filter.statusIn).toEqual(['Open', 'InProgress']);
    // 'mine' の担当者条件も残っていること
    expect(filter.assigneeId).toBe('agent-1');
  });

  // 期限条件と「未完了のみ」を同時に指定しても、どちらも残ること
  it('keeps both the due and open conditions when they are combined', () => {
    // 「期限間近」+「未完了のみ」を同時に指定する
    const filter = buildTicketListFilter({ due: 'soon', open: '1' }, AGENT_CTX);
    // 期限条件が付いていること
    expect(filter.dueSoon).toEqual({ now: NOW });
    // 状態条件も付いていること
    expect(filter.statusIn).toEqual([...UNRESOLVED_STATUSES]);
  });

  // 状況 (単一) と「未完了のみ」は両方が条件として残ること。
  // データ層はこの 2 つを AND で評価するので、矛盾する組み合わせは 0 件になる
  it('keeps both status and statusIn so the data layer can AND them', () => {
    // 「解決済み」+「未完了のみ」という矛盾する組み合わせを指定する
    const filter = buildTicketListFilter({ status: 'Resolved', open: '1' }, AGENT_CTX);
    // 単一の状態条件が残っていること
    expect(filter.status).toBe('Resolved');
    // 複数の状態条件も残っていること (片方が消えると絞り込みが黙って効かなくなる)
    expect(filter.statusIn).toEqual([...UNRESOLVED_STATUSES]);
  });

  // **RBAC の回帰防止**: どの絞り込みを重ねても、依頼者の creatorId 条件が落ちないこと。
  // 絞り込みヘルパーはすべて浅いコピーを返す契約だが、1 つでも破ると
  // 依頼者が他人のチケットを一覧できてしまう (§9 認可はサーバー側で強制する)
  it('never drops the requester scope no matter which filters are combined', () => {
    // 現状の絞り込みをすべて重ねた状態で組み立てる
    const filter = buildTicketListFilter(
      { tab: 'mine', due: 'soon', open: '1', status: 'Open', q: 'foo' },
      REQUESTER_CTX,
    );
    // 依頼者の RBAC 条件が残っていること
    expect(filter.creatorId).toBe('user-1');
  });

  // 列挙外の状況・優先度は「絞り込みなし」に倒れること (URL は信頼できない入力 §9)
  it('ignores status and priority values outside the enum', () => {
    const filter = buildTicketListFilter({ status: 'Bogus', priority: 'Urgent' }, AGENT_CTX);
    expect(filter.status).toBeUndefined();
    expect(filter.priority).toBeUndefined();
  });

  // **実在するすべての優先度が絞り込みとして通ること。**
  //
  // /code-review ultra 指摘対応: 有効な優先度の一覧は
  // `['Low','Medium','High'] as const satisfies Priority[]` と書き並べられていた。
  // `satisfies` が確かめるのは「列挙した各要素が Priority であること」だけで、
  // **全部が列挙されていることは検査しない** (実測: domain/types.ts の Priority に
  // 値を足しても、その宣言に対する型エラーは 1 件も出なかった)。
  // 取り残されると `?priority=<新しい値>` が黙って捨てられ、一覧も CSV エクスポートも
  // **絞り込み無しの全件**を返す一方でドロップダウンはその値を選択済みに見せる。
  //
  // いまは Record<Priority, …> のキーから導出しているので、この検査は今日は自明に通る。
  // **load-bearing になるのは「literal の列挙へ戻され、かつ優先度が増えたとき」**で、
  // そのとき表 (SLA の Record) だけが型検査で追随し、literal が取り残されて落ちる。
  it('accepts every priority that actually exists', () => {
    // 型で網羅性が強制されている唯一の宣言から、実在する優先度を取り出す
    for (const priority of Object.keys(SLA_RESOLUTION_HOURS_BY_PRIORITY)) {
      // どの優先度も「絞り込みとして採用された」状態になること (undefined に倒れない)
      expect(buildTicketListFilter({ priority }, AGENT_CTX).priority).toBe(priority);
    }
  });
});
