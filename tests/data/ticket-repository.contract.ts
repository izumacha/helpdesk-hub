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

// 既定で使うテナント ID (旧テストは単一テナントを前提に書かれているのでここで共通化)
const TENANT_ID = 'default-tenant';

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
  /**
   * Seeds an additional, isolated tenant ('tenant-b') with one requester user.
   * Used by cross-tenant regression tests to verify Adapter-side scoping.
   */
  seedSecondTenant: () => Promise<{ tenantId: string; requester: User; categoryId: string }>;
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
        tenantId: TENANT_ID,
      });
      // 初期ステータスは New、作成者も正しく結びつく
      expect(created.status).toBe('New');
      expect(created.creator.id).toBe(requester.id);

      // ID + tenantId で取り直して内容が一致すること
      const found = await ctx.repos.tickets.findById(created.id, TENANT_ID);
      expect(found?.title).toBe('ログインできません');
      expect(found?.priority).toBe('High');
    });

    // status を省略すると DB 既定の New で起票されること (Pro 既定の挙動)
    it('create without status defaults to New', async () => {
      const { requester, categoryId } = await ctx.seedBasicFixture();
      // status を渡さずに作成する
      const created = await ctx.repos.tickets.create({
        title: 'プリンタが動かない',
        body: '電源は入るが印刷されない',
        priority: 'Medium',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
      });
      // 初期ステータスは New になる
      expect(created.status).toBe('New');
    });

    // status を明示すると、その値で起票されること (Lite は 'Open'=未対応 で起票する)
    it('create honors an explicit initial status', async () => {
      const { requester, categoryId } = await ctx.seedBasicFixture();
      // Lite モードを模して status: 'Open' を明示的に渡す
      const created = await ctx.repos.tickets.create({
        title: 'メールが届かない',
        body: '昨日から受信できていない',
        priority: 'Medium',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
        status: 'Open',
      });
      // 指定したとおり Open(未対応) で起票される
      expect(created.status).toBe('Open');
      // 取り直しても Open のまま永続化されていること
      const found = await ctx.repos.tickets.findById(created.id, TENANT_ID);
      expect(found?.status).toBe('Open');
    });

    // フォローアップ (2026-07-13, /code-review ultra 指摘対応): CSV インポートが追加した
    // assigneeId / firstRespondedAt / createdAt の明示指定が、Prisma / メモリ両アダプタで
    // 同じように永続化されることを確認する (この契約テストは runTicketRepositoryContract 経由で
    // 両アダプタに対して実行されるため、片方の adapter だけが実装を怠っても検出できる)。
    it('create honors explicit assigneeId / firstRespondedAt / createdAt', async () => {
      const { requester, agentA, categoryId } = await ctx.seedBasicFixture();
      // 明示的に過去の時刻を作成日時として指定する
      const explicitCreatedAt = new Date('2026-01-01T00:00:00.000Z');
      const created = await ctx.repos.tickets.create({
        title: 'CSV インポートされたチケット',
        body: '既に対応中だった問い合わせ',
        priority: 'Medium',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
        status: 'InProgress',
        assigneeId: agentA.id,
        firstRespondedAt: explicitCreatedAt,
        createdAt: explicitCreatedAt,
      });
      // 指定した担当者・初回応答日時・作成日時がそのまま保存されること
      expect(created.assignee?.id).toBe(agentA.id);
      expect(created.firstRespondedAt?.toISOString()).toBe(explicitCreatedAt.toISOString());
      expect(created.createdAt.toISOString()).toBe(explicitCreatedAt.toISOString());
      // firstRespondedAt が createdAt より前にならないこと (回帰防止)
      expect(created.firstRespondedAt!.getTime()).toBeGreaterThanOrEqual(
        created.createdAt.getTime(),
      );

      // 取り直しても同じ値のまま永続化されていること
      // (findById は関連情報を含まない素の Ticket を返すため assigneeId で確認する。
      // 関連込みの確認は上の created.assignee?.id で既に行っている)
      const found = await ctx.repos.tickets.findById(created.id, TENANT_ID);
      expect(found?.assigneeId).toBe(agentA.id);
      expect(found?.firstRespondedAt?.toISOString()).toBe(explicitCreatedAt.toISOString());
      expect(found?.createdAt.toISOString()).toBe(explicitCreatedAt.toISOString());
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
        tenantId: TENANT_ID,
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
        tenantId: TENANT_ID,
      });

      // 依頼者で絞ると古い方だけが返る (tenantId 必須)
      const requesterOnly = await ctx.repos.tickets.list({
        filter: { creatorId: requester.id },
        page: { skip: 0, take: 50 },
        tenantId: TENANT_ID,
      });
      expect(requesterOnly.map((t) => t.id)).toEqual([t1.id]);

      // 全件取得は新しい順
      const all = await ctx.repos.tickets.list({
        filter: {},
        page: { skip: 0, take: 50 },
        tenantId: TENANT_ID,
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
        tenantId: TENANT_ID,
      });
      // 本文に小文字の "vpn" を含む
      await ctx.repos.tickets.create({
        title: 'プリンタ不調',
        body: 'vpn 関連では無さそう',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
      });
      // どちらにも含まないノイズ
      await ctx.repos.tickets.create({
        title: '経費申請',
        body: '無関係',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
      });

      // "VPN" 大文字小文字無視で 2 件ヒット
      const result = await ctx.repos.tickets.list({
        filter: { text: { contains: 'VPN', caseInsensitive: true } },
        page: { skip: 0, take: 50 },
        tenantId: TENANT_ID,
      });
      expect(result).toHaveLength(2);

      // count でも 2 件
      const countResult = await ctx.repos.tickets.count(
        {
          text: { contains: 'VPN', caseInsensitive: true },
        },
        TENANT_ID,
      );
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
        tenantId: TENANT_ID,
      });
      await ctx.repos.tickets.updateAssignee(assigned.id, agentA.id, TENANT_ID);
      // 担当者なしのチケット
      const unassigned = await ctx.repos.tickets.create({
        title: 'B',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
      });

      const result = await ctx.repos.tickets.list({
        filter: { assigneeId: null },
        page: { skip: 0, take: 50 },
        tenantId: TENANT_ID,
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
        tenantId: TENANT_ID,
      });

      // ステータス更新 + 履歴記録 + 例外、を 1 つの uow で実行
      await expect(
        ctx.uow.run(async (r) => {
          await r.tickets.updateStatus(ticket.id, { from: 'New', to: 'Open' }, null, TENANT_ID);
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
      const after = await ctx.repos.tickets.findById(ticket.id, TENANT_ID);
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
        tenantId: TENANT_ID,
      });

      // 取得して書き換えても、内部状態に影響しないことを期待
      const leaked = await ctx.repos.tickets.findById(created.id, TENANT_ID);
      if (leaked) {
        (leaked as { title: string }).title = 'MUTATED';
        (leaked as { status: 'New' | 'Open' }).status = 'Open';
      }

      // 再取得すると元の値が保たれている
      const reread = await ctx.repos.tickets.findById(created.id, TENANT_ID);
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
        tenantId: TENANT_ID,
        resolutionDueAt: yesterday,
      });
      // requester: Open 1 件 (期限内、agentA に割当)
      const t2 = await ctx.repos.tickets.create({
        title: 't2',
        body: 'b',
        priority: 'Medium',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
        resolutionDueAt: tomorrow,
      });
      await ctx.repos.tickets.updateStatus(t2.id, { from: 'New', to: 'Open' }, null, TENANT_ID);
      await ctx.repos.tickets.updateAssignee(t2.id, agentA.id, TENANT_ID);
      // agentA 起票の Resolved 1 件 (ワークロード集計から除外される)
      const t3 = await ctx.repos.tickets.create({
        title: 't3',
        body: 'b',
        priority: 'Low',
        creatorId: agentA.id,
        categoryId,
        tenantId: TENANT_ID,
      });
      await ctx.repos.tickets.updateAssignee(t3.id, agentB.id, TENANT_ID);
      await ctx.repos.tickets.updateStatus(t3.id, { from: 'New', to: 'Resolved' }, new Date(), TENANT_ID);

      // creatorId 未指定 = テナント内全件対象 (担当者ビュー)
      const all = await ctx.repos.tickets.dashboardStats({
        now,
        excludeStatusesForWorkload: ['Resolved', 'Closed'],
        tenantId: TENANT_ID,
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
        tenantId: TENANT_ID,
      });
      // byStatus は requester のチケット 2 件のみ
      expect(mine.byStatus.New).toBe(1);
      expect(mine.byStatus.Open).toBe(1);
      expect(mine.byStatus.Resolved).toBe(0);
      // SLA 超過 / ワークロードは全件対象 (呼び出し側で表示制御する前提)
      expect(mine.slaOverdue).toBe(1);
    });

    // Phase 4 多拠点: dashboardStats / qualityMetrics が locationId で絞り込めること
    // (ダッシュボードの拠点フィルタ機能フォローアップ)
    it('dashboardStats and qualityMetrics scope aggregates to the given locationId', async () => {
      const { requester, categoryId } = await ctx.seedBasicFixture();
      // 拠点を 2 つ作成する
      const locationA = await ctx.repos.locations.create({ tenantId: TENANT_ID, name: '拠点A' });
      const locationB = await ctx.repos.locations.create({ tenantId: TENANT_ID, name: '拠点B' });

      // 拠点A: New 2 件 (うち 1 件を解決済みにして品質メトリクスの母数にする)
      const a1 = await ctx.repos.tickets.create({
        title: 'a1',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        locationId: locationA.id,
        tenantId: TENANT_ID,
      });
      await ctx.repos.tickets.updateStatus(a1.id, { from: 'New', to: 'Resolved' }, new Date(), TENANT_ID);
      await ctx.repos.tickets.create({
        title: 'a2',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        locationId: locationA.id,
        tenantId: TENANT_ID,
      });
      // 拠点B: New 1 件
      await ctx.repos.tickets.create({
        title: 'b1',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        locationId: locationB.id,
        tenantId: TENANT_ID,
      });
      // 拠点未設定: New 1 件 (locationId 未指定のフィルタには含まれるが、
      // 拠点A/Bどちらのフィルタにも含まれないことを確認する対象)
      await ctx.repos.tickets.create({
        title: 'no-location',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
      });

      // locationId 未指定 (全拠点対象) なら 4 件すべてが対象
      const allStats = await ctx.repos.tickets.dashboardStats({
        now: new Date(),
        excludeStatusesForWorkload: ['Resolved', 'Closed'],
        tenantId: TENANT_ID,
      });
      expect(allStats.byStatus.New + allStats.byStatus.Resolved).toBe(4);

      // 拠点A 指定なら 2 件 (New 1 + Resolved 1) だけが対象
      const statsA = await ctx.repos.tickets.dashboardStats({
        now: new Date(),
        excludeStatusesForWorkload: ['Resolved', 'Closed'],
        tenantId: TENANT_ID,
        locationId: locationA.id,
      });
      expect(statsA.byStatus.New).toBe(1);
      expect(statsA.byStatus.Resolved).toBe(1);

      // 拠点B 指定なら 1 件 (New) だけが対象
      const statsB = await ctx.repos.tickets.dashboardStats({
        now: new Date(),
        excludeStatusesForWorkload: ['Resolved', 'Closed'],
        tenantId: TENANT_ID,
        locationId: locationB.id,
      });
      expect(statsB.byStatus.New).toBe(1);
      expect(statsB.byStatus.Resolved).toBe(0);

      // qualityMetrics も同様に拠点A指定なら resolvedCount が 1 件 (a1 のみ) になる
      const metricsA = await ctx.repos.tickets.qualityMetrics({
        tenantId: TENANT_ID,
        locationId: locationA.id,
      });
      expect(metricsA.resolvedCount).toBe(1);
      // 拠点B指定なら解決済みチケットが無いので resolvedCount は 0
      const metricsB = await ctx.repos.tickets.qualityMetrics({
        tenantId: TENANT_ID,
        locationId: locationB.id,
      });
      expect(metricsB.resolvedCount).toBe(0);
    });

    // --- ここからクロステナント回帰テスト (Phase 0 仕上げ PR で追加) ---

    // テナント A のチケットがテナント B からは findById で取れないこと
    it('findById does not leak tickets across tenants', async () => {
      const { requester: rA, categoryId: catA } = await ctx.seedBasicFixture();
      // テナント A 側に 1 件作成
      const ticketA = await ctx.repos.tickets.create({
        title: 'A の社内',
        body: 'b',
        priority: 'Low',
        creatorId: rA.id,
        categoryId: catA,
        tenantId: TENANT_ID,
      });
      // テナント B を別途用意
      const { tenantId: tenantB } = await ctx.seedSecondTenant();

      // A の ID をテナント B のスコープで引いても null が返る (クロステナント遮断)
      const leak = await ctx.repos.tickets.findById(ticketA.id, tenantB);
      expect(leak).toBeNull();

      // 正しいテナントなら当然取れる
      const sane = await ctx.repos.tickets.findById(ticketA.id, TENANT_ID);
      expect(sane?.id).toBe(ticketA.id);
    });

    // テナント A のチケットがテナント B からは list / count に出てこないこと
    it('list and count do not leak tickets across tenants', async () => {
      const { requester: rA, categoryId: catA } = await ctx.seedBasicFixture();
      // テナント A 側に 2 件作成
      await ctx.repos.tickets.create({
        title: 'A-1',
        body: 'b',
        priority: 'Low',
        creatorId: rA.id,
        categoryId: catA,
        tenantId: TENANT_ID,
      });
      await ctx.repos.tickets.create({
        title: 'A-2',
        body: 'b',
        priority: 'Low',
        creatorId: rA.id,
        categoryId: catA,
        tenantId: TENANT_ID,
      });
      // テナント B 側に 1 件作成
      const { tenantId: tenantB, requester: rB, categoryId: catB } = await ctx.seedSecondTenant();
      await ctx.repos.tickets.create({
        title: 'B-1',
        body: 'b',
        priority: 'Low',
        creatorId: rB.id,
        categoryId: catB,
        tenantId: tenantB,
      });

      // テナント A 視点では A のチケット 2 件だけが見える
      const listedA = await ctx.repos.tickets.list({
        filter: {},
        page: { skip: 0, take: 50 },
        tenantId: TENANT_ID,
      });
      expect(listedA.map((t) => t.title).sort()).toEqual(['A-1', 'A-2']);
      // count も同じ件数
      expect(await ctx.repos.tickets.count({}, TENANT_ID)).toBe(2);

      // テナント B 視点では B のチケット 1 件だけが見える
      const listedB = await ctx.repos.tickets.list({
        filter: {},
        page: { skip: 0, take: 50 },
        tenantId: tenantB,
      });
      expect(listedB.map((t) => t.title)).toEqual(['B-1']);
      expect(await ctx.repos.tickets.count({}, tenantB)).toBe(1);
    });

    // 他テナントの ID を指定した update 系メソッドが no-op (=データ未改変) であること
    it('write methods refuse to mutate rows owned by another tenant', async () => {
      const { requester: rA, agentA, categoryId: catA } = await ctx.seedBasicFixture();
      // テナント A に 1 件作成 (初期 New / 担当者なし / 優先度 Low)
      const ticketA = await ctx.repos.tickets.create({
        title: 'A の社内',
        body: 'b',
        priority: 'Low',
        creatorId: rA.id,
        categoryId: catA,
        tenantId: TENANT_ID,
      });
      // テナント B を用意 (チケット A への影響を確認するために使う)
      const { tenantId: tenantB } = await ctx.seedSecondTenant();

      // テナント B のスコープから A のチケットを更新しようとしても適用されないことを確認
      await ctx.repos.tickets.updateStatus(ticketA.id, { from: 'New', to: 'Open' }, null, tenantB);
      await ctx.repos.tickets.updatePriority(
        ticketA.id,
        'High',
        { firstResponseDueAt: null, resolutionDueAt: null },
        tenantB,
      );
      await ctx.repos.tickets.updateAssignee(ticketA.id, agentA.id, tenantB);
      await ctx.repos.tickets.markEscalated(
        ticketA.id,
        { reason: 'cross-tenant attempt', at: new Date() },
        'New',
        tenantB,
      );
      await ctx.repos.tickets.markFirstResponded(ticketA.id, new Date(), tenantB);

      // A 側の状態は一切変わっていないこと (status=New, priority=Low, assignee=null)
      const fresh = await ctx.repos.tickets.findById(ticketA.id, TENANT_ID);
      expect(fresh?.status).toBe('New');
      expect(fresh?.priority).toBe('Low');
      expect(fresh?.assigneeId).toBeNull();
      expect(fresh?.escalatedAt).toBeNull();
      expect(fresh?.firstRespondedAt).toBeNull();
    });

    // markFirstResponded が同テナントの行には正しく反映されること
    it('markFirstResponded records the timestamp for a same-tenant ticket', async () => {
      const { requester, categoryId } = await ctx.seedBasicFixture();
      const ticket = await ctx.repos.tickets.create({
        title: '初回応答未対応',
        body: 'b',
        priority: 'Medium',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
      });
      expect(ticket.firstRespondedAt).toBeNull();

      const respondedAt = new Date();
      await ctx.repos.tickets.markFirstResponded(ticket.id, respondedAt, TENANT_ID);

      const fresh = await ctx.repos.tickets.findById(ticket.id, TENANT_ID);
      expect(fresh?.firstRespondedAt?.getTime()).toBe(respondedAt.getTime());
    });

    // 回帰防止: markFirstResponded は既に初回応答済みの行を上書きしないこと (TOCTOU 対策)。
    // POST /api/tickets/[id]/comments はトランザクション開始前に取得したチケットの
    // firstRespondedAt スナップショットで「まだ未応答か」を判定するため、ほぼ同時に届いた
    // 2 件目以降のコメントが古いスナップショットのまま markFirstResponded を呼んでしまいうる。
    // その場合でも「最初の」応答時刻が後勝ちで上書きされてはならない
    it('markFirstResponded does not overwrite an already-recorded response time', async () => {
      const { requester, categoryId } = await ctx.seedBasicFixture();
      const ticket = await ctx.repos.tickets.create({
        title: '初回応答済み',
        body: 'b',
        priority: 'Medium',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
      });

      // 1 件目の応答 (これが「最初の応答」として記録されるべき)
      const firstAt = new Date();
      await ctx.repos.tickets.markFirstResponded(ticket.id, firstAt, TENANT_ID);

      // 2 件目の応答 (古いスナップショット判定に基づく呼び出しを模した、後から来た呼び出し)
      const secondAt = new Date(firstAt.getTime() + 60_000);
      await ctx.repos.tickets.markFirstResponded(ticket.id, secondAt, TENANT_ID);

      // firstRespondedAt は 1 件目の時刻のまま (2 件目で上書きされない)
      const fresh = await ctx.repos.tickets.findById(ticket.id, TENANT_ID);
      expect(fresh?.firstRespondedAt?.getTime()).toBe(firstAt.getTime());
    });

    // dashboardStats が他テナントのチケットを集計に含めないこと
    it('dashboardStats scopes aggregates to the given tenant', async () => {
      const { requester: rA, categoryId: catA } = await ctx.seedBasicFixture();
      // テナント A: New 1 件
      await ctx.repos.tickets.create({
        title: 'A',
        body: 'b',
        priority: 'Low',
        creatorId: rA.id,
        categoryId: catA,
        tenantId: TENANT_ID,
      });
      // テナント B: New 2 件
      const { tenantId: tenantB, requester: rB, categoryId: catB } = await ctx.seedSecondTenant();
      await ctx.repos.tickets.create({
        title: 'B-1',
        body: 'b',
        priority: 'Low',
        creatorId: rB.id,
        categoryId: catB,
        tenantId: tenantB,
      });
      await ctx.repos.tickets.create({
        title: 'B-2',
        body: 'b',
        priority: 'Low',
        creatorId: rB.id,
        categoryId: catB,
        tenantId: tenantB,
      });

      // テナント A のダッシュボードには New 1 件しか出ない
      const statsA = await ctx.repos.tickets.dashboardStats({
        now: new Date(),
        excludeStatusesForWorkload: ['Resolved', 'Closed'],
        tenantId: TENANT_ID,
      });
      expect(statsA.byStatus.New).toBe(1);
      // テナント B のダッシュボードには New 2 件しか出ない
      const statsB = await ctx.repos.tickets.dashboardStats({
        now: new Date(),
        excludeStatusesForWorkload: ['Resolved', 'Closed'],
        tenantId: tenantB,
      });
      expect(statsB.byStatus.New).toBe(2);
    });

    // --- Lite モード追加フィルタ (statusIn / overdue) の契約 ---

    // statusIn を渡すと指定した複数ステータスのチケットだけが取得できる
    it('list with statusIn returns tickets matching any of the given statuses', async () => {
      const { requester, categoryId } = await ctx.seedBasicFixture();
      // New 状態のチケットを 1 件
      const tNew = await ctx.repos.tickets.create({
        title: 'new',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
      });
      // Open に遷移させたチケットを 1 件
      const tOpen = await ctx.repos.tickets.create({
        title: 'open',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
      });
      await ctx.repos.tickets.updateStatus(tOpen.id, { from: 'New', to: 'Open' }, null, TENANT_ID);
      // InProgress に遷移させたチケットを 1 件
      const tInProgress = await ctx.repos.tickets.create({
        title: 'in-progress',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
      });
      await ctx.repos.tickets.updateStatus(tInProgress.id, { from: 'New', to: 'Open' }, null, TENANT_ID);
      await ctx.repos.tickets.updateStatus(
        tInProgress.id,
        { from: 'Open', to: 'InProgress' },
        null,
        TENANT_ID,
      );

      // statusIn=[Open, InProgress] で 2 件 (Open と InProgress) が返り New は除外される
      const result = await ctx.repos.tickets.list({
        filter: { statusIn: ['Open', 'InProgress'] },
        page: { skip: 0, take: 50 },
        tenantId: TENANT_ID,
      });
      const ids = result.map((t) => t.id).sort();
      expect(ids).toEqual([tOpen.id, tInProgress.id].sort());
      expect(ids).not.toContain(tNew.id);
    });

    // overdue フィルタが期限超過 + 未解決のみを返すこと
    it('list with overdue filter returns only past-due, unresolved tickets', async () => {
      const { requester, categoryId } = await ctx.seedBasicFixture();
      // 基準時刻を未来側に設定 (作成済みチケットの期限を相対的に過去にする)
      const now = new Date('2030-06-01T00:00:00Z');
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      // 期限超過 + 未解決のチケット (Open 状態) → ヒット対象
      const overdueUnresolved = await ctx.repos.tickets.create({
        title: 'overdue-open',
        body: 'b',
        priority: 'High',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
        resolutionDueAt: yesterday,
      });
      await ctx.repos.tickets.updateStatus(
        overdueUnresolved.id,
        { from: 'New', to: 'Open' },
        null,
        TENANT_ID,
      );
      // 期限超過だが解決済み (Resolved) → 除外
      const overdueResolved = await ctx.repos.tickets.create({
        title: 'overdue-resolved',
        body: 'b',
        priority: 'High',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
        resolutionDueAt: yesterday,
      });
      await ctx.repos.tickets.updateStatus(
        overdueResolved.id,
        { from: 'New', to: 'Open' },
        null,
        TENANT_ID,
      );
      await ctx.repos.tickets.updateStatus(
        overdueResolved.id,
        { from: 'Open', to: 'Resolved' },
        new Date(),
        TENANT_ID,
      );
      // 期限が未来 → 除外
      await ctx.repos.tickets.create({
        title: 'future-due',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
        resolutionDueAt: tomorrow,
      });
      // 期限なし → 除外
      await ctx.repos.tickets.create({
        title: 'no-due',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
      });

      // overdue フィルタで期限超過 + 未解決のみが返る
      const overdue = await ctx.repos.tickets.list({
        filter: { overdue: { now } },
        page: { skip: 0, take: 50 },
        tenantId: TENANT_ID,
      });
      expect(overdue.map((t) => t.id)).toEqual([overdueUnresolved.id]);
      // count も同じ件数
      expect(await ctx.repos.tickets.count({ overdue: { now } }, TENANT_ID)).toBe(1);
    });

    // フォローアップ (2026-07-15 #2): check-then-act 競合 (TOCTOU) の防止。§1.4 で
    // FaqRepository.updateStatus に導入した「期待する現在状態 (from) が一致するときだけ
    // 更新し、一致しなければ false を返す」契約を TicketRepository.updateStatus/markEscalated
    // にも適用したことの回帰テスト (faq-repository.contract.prisma.test.ts / memory.test.ts と同じ観点)。
    describe('updateStatus / markEscalated の原子的更新 (check-then-act 競合防止)', () => {
      // 期待状態 (from) が現在の状態と一致していれば更新でき、true を返す
      it('updateStatus は期待状態が一致する場合に更新でき true を返す', async () => {
        const { requester, categoryId } = await ctx.seedBasicFixture();
        const ticket = await ctx.repos.tickets.create({
          title: 't',
          body: 'b',
          priority: 'Medium',
          creatorId: requester.id,
          categoryId,
          tenantId: TENANT_ID,
        });

        const updated = await ctx.repos.tickets.updateStatus(
          ticket.id,
          { from: 'New', to: 'Open' },
          null,
          TENANT_ID,
        );

        expect(updated).toBe(true);
        const after = await ctx.repos.tickets.findById(ticket.id, TENANT_ID);
        expect(after?.status).toBe('Open');
      });

      // 期待状態 (from) が現在の状態と異なる場合 (= 別の操作が先に状態を変えていた) は
      // 更新せず false を返し、行の状態も変化しないこと
      it('updateStatus は期待状態が一致しない場合に更新せず false を返す', async () => {
        const { requester, categoryId } = await ctx.seedBasicFixture();
        const ticket = await ctx.repos.tickets.create({
          title: 't',
          body: 'b',
          priority: 'Medium',
          creatorId: requester.id,
          categoryId,
          tenantId: TENANT_ID,
        });
        // 実際の状態は New のまま、期待状態を誤って 'Open' として更新を試みる
        // (先行する別の操作が状態を変えたケースの再現)
        const updated = await ctx.repos.tickets.updateStatus(
          ticket.id,
          { from: 'Open', to: 'InProgress' },
          null,
          TENANT_ID,
        );

        expect(updated).toBe(false);
        // 状態は New のまま変化していない
        const after = await ctx.repos.tickets.findById(ticket.id, TENANT_ID);
        expect(after?.status).toBe('New');
      });

      // markEscalated も同じ契約: 期待状態が一致すれば true、一致しなければ false で no-op
      it('markEscalated は期待状態が一致する場合のみエスカレーションでき、一致しなければ false で no-op', async () => {
        const { requester, categoryId } = await ctx.seedBasicFixture();
        const ticket = await ctx.repos.tickets.create({
          title: 't',
          body: 'b',
          priority: 'High',
          creatorId: requester.id,
          categoryId,
          tenantId: TENANT_ID,
        });
        await ctx.repos.tickets.updateStatus(ticket.id, { from: 'New', to: 'Open' }, null, TENANT_ID);

        // 期待状態を誤って 'InProgress' として試みる (実際は Open) → 競合として false
        const conflicted = await ctx.repos.tickets.markEscalated(
          ticket.id,
          { reason: 'r1', at: new Date() },
          'InProgress',
          TENANT_ID,
        );
        expect(conflicted).toBe(false);
        const stillOpen = await ctx.repos.tickets.findById(ticket.id, TENANT_ID);
        expect(stillOpen?.status).toBe('Open');
        expect(stillOpen?.escalatedAt).toBeNull();

        // 正しい期待状態 (Open) で試みると成功する
        const succeeded = await ctx.repos.tickets.markEscalated(
          ticket.id,
          { reason: 'r2', at: new Date() },
          'Open',
          TENANT_ID,
        );
        expect(succeeded).toBe(true);
        const escalated = await ctx.repos.tickets.findById(ticket.id, TENANT_ID);
        expect(escalated?.status).toBe('Escalated');
        expect(escalated?.escalationReason).toBe('r2');
      });
    });

    // フォローアップ (2026-07-15): updatePriority が渡された dueDates (期限) も同時に永続化すること
    // (優先度変更に追随した SLA 期限の再計算。update-ticket.ts::updateTicketPriority が計算して渡す)
    it('updatePriority は優先度と一緒に渡された dueDates も永続化する', async () => {
      const { requester, categoryId } = await ctx.seedBasicFixture();
      const ticket = await ctx.repos.tickets.create({
        title: 't',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
        tenantId: TENANT_ID,
      });
      const newFirstResponseDueAt = new Date('2026-08-01T00:00:00.000Z');
      const newResolutionDueAt = new Date('2026-08-02T00:00:00.000Z');

      await ctx.repos.tickets.updatePriority(
        ticket.id,
        'High',
        { firstResponseDueAt: newFirstResponseDueAt, resolutionDueAt: newResolutionDueAt },
        TENANT_ID,
      );

      const after = await ctx.repos.tickets.findById(ticket.id, TENANT_ID);
      expect(after?.priority).toBe('High');
      expect(after?.firstResponseDueAt?.getTime()).toBe(newFirstResponseDueAt.getTime());
      expect(after?.resolutionDueAt?.getTime()).toBe(newResolutionDueAt.getTime());
    });
  });
}
