/**
 * Notification repository contract.
 *
 * Exported as a plain function (not a `*.test.ts` file) so it can be invoked
 * against every adapter (memory / Prisma). See
 * `notification-repository.contract.test.ts` for the in-memory run and
 * `notification-repository.contract.prisma.test.ts` for the DB-backed run.
 *
 * 主眼: markAllRead が tenantId スコープを守り、他テナント由来の通知を既読化しないこと
 * (userId 偽装によるクロステナント既読化ギャップを塞ぐ回帰テスト)。
 */

// Vitest のテスト DSL (describe=グループ, it=ケース, beforeEach=前処理, expect=検証)
import { describe, expect, it, beforeEach } from 'vitest';
// 検証対象である通知リポジトリの契約 (port) 型
import type { NotificationRepository } from '@/data/ports/notification-repository';

// 契約テストが利用する文脈 (アダプタ別に差し替え可能)
export interface NotificationContractContext {
  // 検証対象の通知リポジトリ実装
  repo: NotificationRepository;
  // テナント A / テナント B を用意し、各テナントに 1 人ずつユーザーを作るシード
  // 戻り値はテスト本体が通知を作るのに使う tenantId / userId 一式
  seedTwoTenants: () => Promise<{
    tenantA: string; // テナント A の ID
    tenantB: string; // テナント B の ID
    userAId: string; // テナント A に属するユーザー ID
    userBId: string; // テナント B に属するユーザー ID
  }>;
  // 指定テナント・指定起票者でチケットを 1 件作り、その ID を返すシード
  // (create のクロステナント fail-closed 検証に使う。seedTwoTenants の後に呼ぶこと)
  seedTicket: (tenantId: string, creatorId: string) => Promise<string>;
}

// アダプタごとに渡される文脈で同一テストを実行する関数
export function runNotificationRepositoryContract(
  makeContext: () => NotificationContractContext | Promise<NotificationContractContext>,
) {
  describe('NotificationRepository contract', () => {
    // テストごとに新しい文脈を保持する変数
    let ctx: NotificationContractContext;

    // 各テストの前に独立した状態のコンテキストを生成する
    beforeEach(async () => {
      ctx = await makeContext();
    });

    // create で作った未読通知が countUnread / list に正しく出ること (基本往復)
    it('create surfaces an unread notification in countUnread and list (scoped to tenant)', async () => {
      // テナント A / B とそれぞれのユーザーを用意する
      const { tenantA, userAId } = await ctx.seedTwoTenants();
      // テナント A のユーザー宛に通知を 1 件作成する
      await ctx.repo.create({
        userId: userAId,
        type: 'assigned',
        message: 'あなたにチケットが割り当てられました',
        tenantId: tenantA,
      });
      // テナント A スコープで未読件数を数えると 1 件になる
      expect(await ctx.repo.countUnread(userAId, tenantA)).toBe(1);
      // 一覧にも 1 件出る
      const listed = await ctx.repo.list(userAId, { limit: 50 }, tenantA);
      expect(listed).toHaveLength(1);
    });

    // markAllRead が指定テナントの通知だけを既読化し、他テナントは未読のまま残すこと
    it('markAllRead does not mark another tenant notifications as read', async () => {
      // テナント A / B と各ユーザーを用意する
      const { tenantA, tenantB, userAId, userBId } = await ctx.seedTwoTenants();

      // テナント A のユーザー宛に未読通知を 1 件作成する
      await ctx.repo.create({
        userId: userAId,
        type: 'assigned',
        message: 'A 向け通知',
        tenantId: tenantA,
      });
      // テナント B のユーザー宛にも未読通知を 1 件作成する
      await ctx.repo.create({
        userId: userBId,
        type: 'assigned',
        message: 'B 向け通知',
        tenantId: tenantB,
      });

      // 前提確認: A も B もそれぞれ未読 1 件ずつある
      expect(await ctx.repo.countUnread(userAId, tenantA)).toBe(1);
      expect(await ctx.repo.countUnread(userBId, tenantB)).toBe(1);

      // テナント A のユーザーとして markAllRead を実行する (A スコープで既読化)
      await ctx.repo.markAllRead(userAId, tenantA);

      // テナント A 側は既読化され、未読が 0 になる
      expect(await ctx.repo.countUnread(userAId, tenantA)).toBe(0);
      // テナント B 側は影響を受けず、未読 1 件のまま残る (クロステナント既読化を防げている)
      expect(await ctx.repo.countUnread(userBId, tenantB)).toBe(1);
    });

    // 同じ userId が別テナントの tenantId で呼ばれても、対象テナントの通知しか既読化しないこと
    // (userId を偽装してもスコープ外の通知へは波及しない、という防御の直接検証)
    it('markAllRead with a mismatched tenant leaves the real tenant notifications unread', async () => {
      // テナント A / B と各ユーザーを用意する
      const { tenantA, tenantB, userAId } = await ctx.seedTwoTenants();

      // テナント A のユーザー宛に未読通知を 1 件作成する
      await ctx.repo.create({
        userId: userAId,
        type: 'assigned',
        message: 'A 向け通知',
        tenantId: tenantA,
      });

      // 攻撃想定: userA の通知をテナント B のスコープで既読化しようとする
      await ctx.repo.markAllRead(userAId, tenantB);

      // テナント B には userA の通知が存在しないので、A 側の通知は未読のまま残る
      expect(await ctx.repo.countUnread(userAId, tenantA)).toBe(1);
    });

    // 関連チケットが同一テナントに属する場合は、ticketId 付きの通知を作成できること (正常系)
    it('create accepts a ticketId that belongs to the same tenant', async () => {
      // テナント A / B と各ユーザーを用意する
      const { tenantA, userAId } = await ctx.seedTwoTenants();
      // テナント A にチケットを 1 件作成する
      const ticketId = await ctx.seedTicket(tenantA, userAId);
      // 同じテナント A のチケットに紐づく通知を作成する → 成功する
      const created = await ctx.repo.create({
        userId: userAId,
        type: 'commented',
        message: 'チケットにコメントが追加されました',
        ticketId,
        tenantId: tenantA,
      });
      // 作成された通知が対象チケットに紐づいていること
      expect(created.ticketId).toBe(ticketId);
    });

    // 関連チケットが別テナントに属する場合、create が fail-closed で拒否すること
    // (コメント Adapter の issue #123 と同じ多層防御をアダプタ側で強制する回帰テスト)
    it('create rejects a ticketId that belongs to another tenant', async () => {
      // テナント A / B と各ユーザーを用意する
      const { tenantA, tenantB, userAId, userBId } = await ctx.seedTwoTenants();
      // テナント A にチケットを 1 件作成する
      const ticketId = await ctx.seedTicket(tenantA, userAId);
      // 攻撃想定: テナント B を名乗ってテナント A のチケットに紐づく通知を作ろうとする → 拒否される
      await expect(
        ctx.repo.create({
          userId: userBId,
          type: 'commented',
          message: '侵入',
          ticketId,
          tenantId: tenantB,
        }),
      ).rejects.toThrow(/チケットが見つかりません/);
      // 拒否された結果、テナント B 側に通知行は 1 件も作られていないこと
      expect(await ctx.repo.countUnread(userBId, tenantB)).toBe(0);
    });

    // 存在しないチケット ID を指定した create も fail-closed で拒否すること
    it('create rejects a non-existent ticketId', async () => {
      // テナント A / B と各ユーザーを用意する
      const { tenantA, userAId } = await ctx.seedTwoTenants();
      // 実在しないチケット ID に紐づく通知を作ろうとする → 拒否される
      await expect(
        ctx.repo.create({
          userId: userAId,
          type: 'commented',
          message: '宛先なし',
          ticketId: 'no-such-ticket',
          tenantId: tenantA,
        }),
      ).rejects.toThrow(/チケットが見つかりません/);
    });
  });
}
