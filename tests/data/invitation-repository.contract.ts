/**
 * Invitation repository contract.
 *
 * Exported as a plain function (not a `*.test.ts` file) so it can be invoked
 * against every adapter (memory / Prisma). See
 * `invitation-repository.contract.test.ts` for the in-memory run and
 * `invitation-repository.contract.prisma.test.ts` for the DB-backed run.
 *
 * 主眼:
 *  - consumeValidToken がワンタイム性 (単回消費) と失効を守ること。
 *  - 消費後の招待が参加先 tenantId / role を正しく運ぶこと (受諾フローの信頼の起点)。
 *  - countRecentByTenant が tenantId スコープを守り、他テナントの発行を数えないこと。
 */

// Vitest のテスト DSL (describe=グループ, it=ケース, beforeEach=前処理, expect=検証)
import { describe, expect, it, beforeEach } from 'vitest';
// 検証対象である招待リポジトリの契約 (port) 型
import type { InvitationRepository } from '@/data/ports/invitation-repository';

// 契約テストが利用する文脈 (アダプタ別に差し替え可能)
export interface InvitationContractContext {
  // 検証対象の招待リポジトリ実装
  repo: InvitationRepository;
  // テナント A / テナント B を用意するシード (招待は tenantId を必須とするため)
  seedTwoTenants: () => Promise<{
    tenantA: string; // テナント A の ID
    tenantB: string; // テナント B の ID
  }>;
}

// アダプタごとに渡される文脈で同一テストを実行する関数
export function runInvitationRepositoryContract(
  makeContext: () => InvitationContractContext | Promise<InvitationContractContext>,
) {
  describe('InvitationRepository contract', () => {
    // テストごとに新しい文脈を保持する変数
    let ctx: InvitationContractContext;

    // 各テストの前に独立した状態のコンテキストを生成する
    beforeEach(async () => {
      ctx = await makeContext();
    });

    // create で作った招待が findByTokenHash で引け、tenantId / role を保持していること (基本往復)
    it('create surfaces an invitation via findByTokenHash with tenant and role', async () => {
      // テナント A / B を用意する
      const { tenantA } = await ctx.seedTwoTenants();
      // テナント A 宛・担当者 (agent) 権限の招待を 1 件作成する
      const expiresAt = new Date(Date.now() + 60_000); // 1 分後に失効
      await ctx.repo.create({
        tokenHash: 'hash-1',
        tenantId: tenantA,
        role: 'agent',
        expiresAt,
      });
      // tokenHash で引き直すと作成した招待が取れる
      const found = await ctx.repo.findByTokenHash('hash-1');
      // 参加先テナントと付与権限が保存されている
      expect(found?.tenantId).toBe(tenantA);
      expect(found?.role).toBe('agent');
      // 作成直後は未消費 (consumedAt が null)
      expect(found?.consumedAt).toBeNull();
    });

    // consumeValidToken は未消費・失効前の招待を消費し、参加先 tenantId を返すこと
    it('consumeValidToken consumes a valid invitation and returns its tenant', async () => {
      // テナント A / B を用意する
      const { tenantA } = await ctx.seedTwoTenants();
      // 有効な招待を 1 件作成する
      await ctx.repo.create({
        tokenHash: 'hash-2',
        tenantId: tenantA,
        role: 'requester',
        expiresAt: new Date(Date.now() + 60_000),
      });
      // 現在時刻で消費する
      const consumed = await ctx.repo.consumeValidToken({ tokenHash: 'hash-2', now: new Date() });
      // 消費に成功し、参加先テナントを運んで返す
      expect(consumed?.tenantId).toBe(tenantA);
      // 消費印 (consumedAt) が立っている
      expect(consumed?.consumedAt).not.toBeNull();
    });

    // 同じ招待リンクは 2 回消費できないこと (ワンタイム性)
    it('consumeValidToken rejects a second consume (single-use)', async () => {
      // テナント A / B を用意する
      const { tenantA } = await ctx.seedTwoTenants();
      // 有効な招待を 1 件作成する
      await ctx.repo.create({
        tokenHash: 'hash-3',
        tenantId: tenantA,
        role: 'requester',
        expiresAt: new Date(Date.now() + 60_000),
      });
      // 1 回目は成功する
      const first = await ctx.repo.consumeValidToken({ tokenHash: 'hash-3', now: new Date() });
      expect(first).not.toBeNull();
      // 2 回目は既に消費済みなので null になる (二重登録を防ぐ)
      const second = await ctx.repo.consumeValidToken({ tokenHash: 'hash-3', now: new Date() });
      expect(second).toBeNull();
    });

    // 失効済みの招待は消費できないこと
    it('consumeValidToken rejects an expired invitation', async () => {
      // テナント A / B を用意する
      const { tenantA } = await ctx.seedTwoTenants();
      // 既に失効している招待を作る (expiresAt が過去)
      await ctx.repo.create({
        tokenHash: 'hash-4',
        tenantId: tenantA,
        role: 'requester',
        expiresAt: new Date(Date.now() - 1_000), // 1 秒前に失効
      });
      // 現在時刻で消費を試みると失効済みのため null
      const consumed = await ctx.repo.consumeValidToken({ tokenHash: 'hash-4', now: new Date() });
      expect(consumed).toBeNull();
    });

    // deleteExpired は失効済みだけを削除し、有効な招待は残すこと
    it('deleteExpired removes only expired invitations', async () => {
      // テナント A / B を用意する
      const { tenantA } = await ctx.seedTwoTenants();
      // 失効済みと有効をそれぞれ 1 件ずつ作る
      await ctx.repo.create({
        tokenHash: 'expired',
        tenantId: tenantA,
        role: 'requester',
        expiresAt: new Date(Date.now() - 1_000),
      });
      await ctx.repo.create({
        tokenHash: 'valid',
        tenantId: tenantA,
        role: 'requester',
        expiresAt: new Date(Date.now() + 60_000),
      });
      // 現在時刻で掃除すると失効済み 1 件だけ消える
      const removed = await ctx.repo.deleteExpired(new Date());
      expect(removed).toBe(1);
      // 有効な招待は残っている
      expect(await ctx.repo.findByTokenHash('valid')).not.toBeNull();
      // 失効済みは消えている
      expect(await ctx.repo.findByTokenHash('expired')).toBeNull();
    });

    // countRecentByTenant がテナントスコープを守り、他テナントの発行を数えないこと
    it('countRecentByTenant is scoped to the tenant', async () => {
      // テナント A / B を用意する
      const { tenantA, tenantB } = await ctx.seedTwoTenants();
      // 直近の基準時刻 (これ以降の発行を数える)
      const since = new Date(Date.now() - 60_000);
      // テナント A に 2 件、テナント B に 1 件の招待を作る
      await ctx.repo.create({
        tokenHash: 'a-1',
        tenantId: tenantA,
        role: 'requester',
        expiresAt: new Date(Date.now() + 60_000),
      });
      await ctx.repo.create({
        tokenHash: 'a-2',
        tenantId: tenantA,
        role: 'requester',
        expiresAt: new Date(Date.now() + 60_000),
      });
      await ctx.repo.create({
        tokenHash: 'b-1',
        tenantId: tenantB,
        role: 'requester',
        expiresAt: new Date(Date.now() + 60_000),
      });
      // テナント A のカウントは 2 件 (B の 1 件は含まない)
      expect(await ctx.repo.countRecentByTenant(tenantA, since)).toBe(2);
      // テナント B のカウントは 1 件
      expect(await ctx.repo.countRecentByTenant(tenantB, since)).toBe(1);
    });
  });
}
