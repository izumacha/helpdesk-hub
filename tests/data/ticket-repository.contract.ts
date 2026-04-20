/**
 * Ticket repository contract.
 *
 * Exported as a plain function (not a `*.test.ts` file) so it can be invoked
 * against every adapter. See `ticket-repository.contract.test.ts` for the
 * in-memory run; a Prisma run can be gated by an env flag once a test DB is
 * available.
 */

// Vitest のテスト DSL
import { describe, expect, it, beforeEach } from 'vitest';
// 検証対象 (リポジトリ束 + UoW) の型
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
// シード返り値で使うユーザー型
import type { User } from '@/domain/types';

// 契約テストが利用する文脈 (アダプタ別に差し替え可能)
export interface ContractContext {
  repos: Repos;
  uow: UnitOfWork;
  /** Seeds a small fixture: 1 requester, 2 agents, 1 category. Returns their ids. */
  seedBasicFixture: () => Promise<{
    requester: User;
    agentA: User;
    agentB: User;
    categoryId: string;
  }>;
}

// アダプタごとに渡される ContractContext で同一テストを実行する関数
export function runTicketRepositoryContract(
  makeContext: () => ContractContext | Promise<ContractContext>,
) {
  describe('TicketRepository contract', () => {
    // テストごとに新しい文脈を作るためのコンテナ
    let ctx: ContractContext;

    // 各テストの前に独立した状態のコンテキストを生成
    beforeEach(async () => {
      ctx = await makeContext();
    });

    // create で書いて findById で取り出すと同じ値が読めること
    it('create + findById round-trips', async () => {
      const { requester, categoryId } = await ctx.seedBasicFixture();
      // 新規作成
      const created = await ctx.repos.tickets.create({
        title: 'ログインできません',
        body: 'パスワードを入れてもはじかれる',
        priority: 'High',
        creatorId: requester.id,
        categoryId,
      });
      // 初期ステータスは New、作成者も正しく結びつく
      expect(created.status).toBe('New');
      expect(created.creator.id).toBe(requester.id);

      // ID で取り直して内容が一致すること
      const found = await ctx.repos.tickets.findById(created.id);
      expect(found?.title).toBe('ログインできません');
      expect(found?.priority).toBe('High');
    });

    // list の creatorId フィルタと並び順 (新しい順) が正しいこと
    it('list applies creatorId filter and returns most-recent first', async () => {
      const { requester, agentA, categoryId } = await ctx.seedBasicFixture();
      // 古い方を依頼者で作成
      const t1 = await ctx.repos.tickets.create({
        title: 'Older',
        body: 'x',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
      });
      // メモリ実装で createdAt が同一にならないよう少し待つ
      await new Promise((r) => setTimeout(r, 2));
      // 新しい方は別人で作成
      const t2 = await ctx.repos.tickets.create({
        title: 'Newer',
        body: 'y',
        priority: 'Medium',
        creatorId: agentA.id,
        categoryId,
      });

      // 依頼者で絞ると古い方だけが返る
      const requesterOnly = await ctx.repos.tickets.list({
        filter: { creatorId: requester.id },
        page: { skip: 0, take: 50 },
      });
      expect(requesterOnly.map((t) => t.id)).toEqual([t1.id]);

      // 全件取得は新しい順
      const all = await ctx.repos.tickets.list({
        filter: {},
        page: { skip: 0, take: 50 },
      });
      expect(all.map((t) => t.id)).toEqual([t2.id, t1.id]);
    });

    // 文字列検索が大文字小文字を無視し、タイトル/本文両方にマッチすること
    it('list with caseInsensitive text search matches title and body across cases', async () => {
      const { requester, categoryId } = await ctx.seedBasicFixture();
      // タイトルに "VPN" を含む
      await ctx.repos.tickets.create({
        title: 'VPN がつながらない',
        body: 'Yamada',
        priority: 'Medium',
        creatorId: requester.id,
        categoryId,
      });
      // 本文に小文字の "vpn" を含む
      await ctx.repos.tickets.create({
        title: 'プリンタ不調',
        body: 'vpn 関連では無さそう',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
      });
      // どちらにも含まないノイズ
      await ctx.repos.tickets.create({
        title: '経費申請',
        body: '無関係',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
      });

      // "VPN" 大文字小文字無視で 2 件ヒット
      const result = await ctx.repos.tickets.list({
        filter: { text: { contains: 'VPN', caseInsensitive: true } },
        page: { skip: 0, take: 50 },
      });
      expect(result).toHaveLength(2);

      // count でも 2 件
      const countResult = await ctx.repos.tickets.count({
        text: { contains: 'VPN', caseInsensitive: true },
      });
      expect(countResult).toBe(2);
    });

    // assigneeId に "unassigned" を渡すと未割当のみが返ること
    it('list with assigneeId "unassigned" returns only null assignees', async () => {
      const { requester, agentA, categoryId } = await ctx.seedBasicFixture();
      // 担当者を付けたチケット
      const assigned = await ctx.repos.tickets.create({
        title: 'A',
        body: 'a',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
      });
      await ctx.repos.tickets.updateAssignee(assigned.id, agentA.id);
      // 担当者なしのチケット
      const unassigned = await ctx.repos.tickets.create({
        title: 'B',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
      });

      const result = await ctx.repos.tickets.list({
        filter: { assigneeId: 'unassigned' },
        page: { skip: 0, take: 50 },
      });
      // 未割当の 1 件だけが返る
      expect(result.map((t) => t.id)).toEqual([unassigned.id]);
    });

    // 担当者別ワークロード集計が除外ステータスを正しく無視すること
    it('workloadByAssignee counts only non-excluded statuses', async () => {
      const { requester, agentA, agentB, categoryId } = await ctx.seedBasicFixture();
      // 1 件作って担当者/状態を設定するヘルパー
      const mk = async (assignee: string | null, status: 'New' | 'Open' | 'Resolved') => {
        const t = await ctx.repos.tickets.create({
          title: 't',
          body: 'b',
          priority: 'Medium',
          creatorId: requester.id,
          categoryId,
        });
        if (assignee) await ctx.repos.tickets.updateAssignee(t.id, assignee);
        if (status !== 'New') {
          await ctx.repos.tickets.updateStatus(
            t.id,
            status,
            status === 'Resolved' ? new Date() : null,
          );
        }
        return t;
      };
      // agentA: Open 2 件、Resolved 1 件 (集計から除外)
      await mk(agentA.id, 'Open');
      await mk(agentA.id, 'Open');
      // agentB: New 1 件
      await mk(agentB.id, 'New');
      await mk(agentA.id, 'Resolved'); // 除外対象
      // 未割当: Open 1 件
      await mk(null, 'Open');

      // Resolved/Closed を除外して集計
      const rows = await ctx.repos.tickets.workloadByAssignee({
        excludeStatuses: ['Resolved', 'Closed'],
      });

      // 担当者 ID をキーに件数を Map 化
      const byAssignee = new Map(rows.map((r) => [r.assigneeId, r.count]));
      expect(byAssignee.get(agentA.id)).toBe(2);
      expect(byAssignee.get(agentB.id)).toBe(1);
      expect(byAssignee.get(null)).toBe(1);
    });

    // uow.run の中で例外を投げると変更が一切残らないこと (ロールバック)
    it('uow.run rolls back on throw', async () => {
      const { requester, categoryId } = await ctx.seedBasicFixture();
      // 事前にチケットを 1 件作っておく
      const ticket = await ctx.repos.tickets.create({
        title: 't',
        body: 'b',
        priority: 'Medium',
        creatorId: requester.id,
        categoryId,
      });

      // ステータス更新 + 履歴記録 + 例外、を 1 つの uow で実行
      await expect(
        ctx.uow.run(async (r) => {
          await r.tickets.updateStatus(ticket.id, 'Open', null);
          await r.history.record({
            ticketId: ticket.id,
            changedById: requester.id,
            field: 'status',
            oldValue: 'New',
            newValue: 'Open',
          });
          // 途中で失敗させる
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      // ステータスは変わらず New のまま
      const after = await ctx.repos.tickets.findById(ticket.id);
      expect(after?.status).toBe('New');
    });

    // findById は呼び出し側で破壊できない防御的コピーを返すこと
    it('findById returns a defensive copy — callers cannot mutate stored state', async () => {
      const { requester, categoryId } = await ctx.seedBasicFixture();
      // 1 件作成
      const created = await ctx.repos.tickets.create({
        title: 'original',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
      });

      // 取得して書き換えても、内部状態に影響しないことを期待
      const leaked = await ctx.repos.tickets.findById(created.id);
      if (leaked) {
        (leaked as { title: string }).title = 'MUTATED';
        (leaked as { status: 'New' | 'Open' }).status = 'Open';
      }

      // 再取得すると元の値が保たれている
      const reread = await ctx.repos.tickets.findById(created.id);
      expect(reread?.title).toBe('original');
      expect(reread?.status).toBe('New');
    });

    // countByStatus が status と creatorId 両方を見て集計すること
    it('countByStatus filters by creator and status', async () => {
      const { requester, agentA, categoryId } = await ctx.seedBasicFixture();
      // requester の Open 1 件
      const t1 = await ctx.repos.tickets.create({
        title: 'a',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
      });
      await ctx.repos.tickets.updateStatus(t1.id, 'Open', null);
      // agentA の New 1 件
      await ctx.repos.tickets.create({
        title: 'c',
        body: 'd',
        priority: 'Low',
        creatorId: agentA.id,
        categoryId,
      });

      // status のみ: Open は全体で 1 件
      expect(await ctx.repos.tickets.countByStatus({ status: 'Open' })).toBe(1);
      // status + creatorId: agentA の Open は 0 件
      expect(await ctx.repos.tickets.countByStatus({ status: 'Open', creatorId: agentA.id })).toBe(
        0,
      );
      // agentA の New は 1 件
      expect(await ctx.repos.tickets.countByStatus({ status: 'New', creatorId: agentA.id })).toBe(
        1,
      );
    });
  });
}
