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
        tenantId: 'default-tenant',
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
        tenantId: 'default-tenant',
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
        tenantId: 'default-tenant',
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
        tenantId: 'default-tenant',
      });
      // 本文に小文字の "vpn" を含む
      await ctx.repos.tickets.create({
        title: 'プリンタ不調',
        body: 'vpn 関連では無さそう',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        tenantId: 'default-tenant',
      });
      // どちらにも含まないノイズ
      await ctx.repos.tickets.create({
        title: '経費申請',
        body: '無関係',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        tenantId: 'default-tenant',
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

    // assigneeId に null を渡すと未割当のみが返ること
    it('list with assigneeId null returns only null assignees', async () => {
      const { requester, agentA, categoryId } = await ctx.seedBasicFixture();
      // 担当者を付けたチケット
      const assigned = await ctx.repos.tickets.create({
        title: 'A',
        body: 'a',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        tenantId: 'default-tenant',
      });
      await ctx.repos.tickets.updateAssignee(assigned.id, agentA.id);
      // 担当者なしのチケット
      const unassigned = await ctx.repos.tickets.create({
        title: 'B',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        tenantId: 'default-tenant',
      });

      const result = await ctx.repos.tickets.list({
        filter: { assigneeId: null },
        page: { skip: 0, take: 50 },
      });
      // 未割当の 1 件だけが返る
      expect(result.map((t) => t.id)).toEqual([unassigned.id]);
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
        tenantId: 'default-tenant',
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
        tenantId: 'default-tenant',
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

    // dashboardStats が状態別件数 / SLA 超過 / ワークロードを一括で返すこと
    it('dashboardStats aggregates byStatus, slaOverdue, workload in one call', async () => {
      const { requester, agentA, agentB, categoryId } = await ctx.seedBasicFixture();
      // 「期限が過去」のチケットを作るために now を未来側に進める基準時刻を用意
      const now = new Date('2030-01-01T00:00:00Z');
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      // requester: New 1 件 (SLA 期限切れ)
      await ctx.repos.tickets.create({
        title: 't1',
        body: 'b',
        priority: 'High',
        creatorId: requester.id,
        categoryId,
        tenantId: 'default-tenant',
        resolutionDueAt: yesterday,
      });
      // requester: Open 1 件 (期限内、agentA に割当)
      const t2 = await ctx.repos.tickets.create({
        title: 't2',
        body: 'b',
        priority: 'Medium',
        creatorId: requester.id,
        categoryId,
        tenantId: 'default-tenant',
        resolutionDueAt: tomorrow,
      });
      await ctx.repos.tickets.updateStatus(t2.id, 'Open', null);
      await ctx.repos.tickets.updateAssignee(t2.id, agentA.id);
      // agentA 起票の Resolved 1 件 (ワークロード集計から除外される)
      const t3 = await ctx.repos.tickets.create({
        title: 't3',
        body: 'b',
        priority: 'Low',
        creatorId: agentA.id,
        categoryId,
        tenantId: 'default-tenant',
      });
      await ctx.repos.tickets.updateAssignee(t3.id, agentB.id);
      await ctx.repos.tickets.updateStatus(t3.id, 'Resolved', new Date());

      // creatorId 未指定 = 全件対象 (担当者ビュー)
      const all = await ctx.repos.tickets.dashboardStats({
        now,
        excludeStatusesForWorkload: ['Resolved', 'Closed'],
      });
      // byStatus: New 1 件 / Open 1 件 / Resolved 1 件、その他は 0
      expect(all.byStatus.New).toBe(1);
      expect(all.byStatus.Open).toBe(1);
      expect(all.byStatus.Resolved).toBe(1);
      expect(all.byStatus.Closed).toBe(0);
      expect(all.byStatus.WaitingForUser).toBe(0);
      // SLA 超過: 期限切れ未解決の 1 件
      expect(all.slaOverdue).toBe(1);
      // ワークロード: agentA に 1 件 (Resolved は除外)、未割当 (null) に 1 件
      const wlByAssignee = new Map(all.workload.map((w) => [w.assigneeId, w.count]));
      expect(wlByAssignee.get(agentA.id)).toBe(1);
      expect(wlByAssignee.get(null)).toBe(1);
      expect(wlByAssignee.get(agentB.id)).toBeUndefined(); // Resolved 担当のみなので除外

      // creatorId 指定 = 依頼者ビュー (byStatus のみ絞られる)
      const mine = await ctx.repos.tickets.dashboardStats({
        creatorId: requester.id,
        now,
        excludeStatusesForWorkload: ['Resolved', 'Closed'],
      });
      // byStatus は requester のチケット 2 件のみ
      expect(mine.byStatus.New).toBe(1);
      expect(mine.byStatus.Open).toBe(1);
      expect(mine.byStatus.Resolved).toBe(0);
      // SLA 超過 / ワークロードは全件対象 (呼び出し側で表示制御する前提)
      expect(mine.slaOverdue).toBe(1);
    });
  });
}
