// LINE 連携設定リポジトリ (Prisma アダプタ) の契約テスト。
// クロステナント分離など、本番 Prisma 実装が満たすべき性質を実 DB に対して検証する。
// docs/smb-dx-pivot-plan.md §4 Phase 2.1。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを
// TRUNCATE するため **開発 DB を指さない** こと (CLAUDE.md §テスト)。

// Vitest の DSL (describe=グループ, beforeAll/afterAll/beforeEach=前後処理, it/expect)
import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
// Prisma クライアント本体 (生成物。DB へ実際に接続して操作する SDK)
import { PrismaClient } from '@/generated/prisma';
// 本番 Prisma 実装の repos 束を組み立てる関数
import { buildPrismaRepos } from '@/data/adapters/prisma';

// テナント A / B の ID
const TENANT_A = 'default-tenant';
const TENANT_B = 'tenant-b';

// この DB 依存テストを実行してよいかどうかの明示フラグ (CI の専用ジョブだけが '1' を立てる)
const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

// Prisma 実装が LineConfigRepository 契約を満たすか検証する (フラグが立っているときだけ走る)
describe.runIf(SHOULD_RUN)('LineConfigRepository (prisma adapter)', () => {
  // 後続のテストから参照する PrismaClient
  let prisma: PrismaClient;

  // スイート開始時に 1 度だけ DB へ接続する
  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  // スイート終了時に接続を確実に閉じる
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // 各テスト前に全テーブルを空にし、テナント A / B を作成する
  beforeEach(async () => {
    // LINE 連携設定 → Tenant の順に依存するが CASCADE が吸収する。TenantLineConfig も明示的に含める
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "TenantLineConfig","TenantSsoConfig","Attachment","TicketHistory","TicketComment","Notification","FaqCandidate","Ticket","Category","MagicLinkToken","User","Tenant" RESTART IDENTITY CASCADE',
    );
    // テナント A / B を作成する
    await prisma.tenant.create({ data: { id: TENANT_A, name: 'デフォルト組織', mode: 'lite' } });
    await prisma.tenant.create({ data: { id: TENANT_B, name: '別組織', mode: 'lite' } });
  });

  // テスト用の LINE 連携設定入力を作るヘルパー
  function input(tenantId: string, botUserId: string) {
    return {
      tenantId,
      channelSecret: `secret-${tenantId}`,
      channelAccessToken: `token-${tenantId}`,
      botUserId,
    };
  }

  // upsert で作成し findByTenant / findByBotUserId で取得できる
  it('upsert で作成し findByTenant / findByBotUserId で取得できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const botUserId = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const created = await repos.lineConfigs.upsert(input(TENANT_A, botUserId));
    // expected を渡していない (無条件 upsert) 呼び出しなので null にはならない
    expect(created?.tenantId).toBe(TENANT_A);
    const byTenant = await repos.lineConfigs.findByTenant(TENANT_A);
    expect(byTenant?.channelSecret).toBe(`secret-${TENANT_A}`);
    const byBotUserId = await repos.lineConfigs.findByBotUserId(botUserId);
    expect(byBotUserId?.tenantId).toBe(TENANT_A);
  });

  // 同一テナントへの upsert は更新になる (1 テナント 1 設定 = @unique tenantId)
  it('同一テナントへの upsert は重複作成せず更新になる', async () => {
    const repos = buildPrismaRepos(prisma);
    const first = await repos.lineConfigs.upsert(
      input(TENANT_A, 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    );
    const second = await repos.lineConfigs.upsert(
      input(TENANT_A, 'Ucccccccccccccccccccccccccccccccc'),
    );
    // 同一レコードの更新なので ID は不変、値だけ変わる (どちらも expected 未指定の無条件 upsert)
    expect(second?.id).toBe(first?.id);
    expect(second?.botUserId).toBe('Ucccccccccccccccccccccccccccccccc');
  });

  // 他テナントが既に使用している botUserId への upsert は一意制約違反でエラーになる
  it('他テナントが使用中の botUserId への upsert はエラーになる (クロステナント混線防止)', async () => {
    const repos = buildPrismaRepos(prisma);
    const sharedBotUserId = 'Uddddddddddddddddddddddddddddddd1';
    await repos.lineConfigs.upsert(input(TENANT_A, sharedBotUserId));
    await expect(repos.lineConfigs.upsert(input(TENANT_B, sharedBotUserId))).rejects.toThrow();
  });

  // クロステナント分離: A の設定は B から取得・削除できない
  it('テナント A の設定はテナント B から取得・削除できない (クロステナント分離)', async () => {
    const repos = buildPrismaRepos(prisma);
    // A にだけ設定を作る
    await repos.lineConfigs.upsert(input(TENANT_A, 'Ueeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'));
    // B からは取得できない
    expect(await repos.lineConfigs.findByTenant(TENANT_B)).toBeNull();
    // B の delete は A に影響しない
    await repos.lineConfigs.delete(TENANT_B);
    expect(await repos.lineConfigs.findByTenant(TENANT_A)).not.toBeNull();
  });

  // delete で自テナントの設定を削除できる
  it('delete で自テナントの設定を削除できる', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.lineConfigs.upsert(input(TENANT_A, 'Uffffffffffffffffffffffffffffffff'));
    await repos.lineConfigs.delete(TENANT_A);
    expect(await repos.lineConfigs.findByTenant(TENANT_A)).toBeNull();
  });
});
