// SSO 設定リポジトリ (Prisma アダプタ) の契約テスト。
// クロステナント分離など、本番 Prisma 実装が満たすべき性質を実 DB に対して検証する。
// docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」。
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

// Prisma 実装が SsoConfigRepository 契約を満たすか検証する (フラグが立っているときだけ走る)
describe.runIf(SHOULD_RUN)('SsoConfigRepository (prisma adapter)', () => {
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
    // SSO 設定 → Tenant の順に依存するが CASCADE が吸収する。TenantSsoConfig も明示的に含める
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "TenantSsoConfig","Attachment","TicketHistory","TicketComment","Notification","FaqCandidate","Ticket","Category","MagicLinkToken","User","Tenant" RESTART IDENTITY CASCADE',
    );
    // テナント A / B を作成する
    await prisma.tenant.create({ data: { id: TENANT_A, name: 'デフォルト組織', mode: 'lite' } });
    await prisma.tenant.create({ data: { id: TENANT_B, name: '別組織', mode: 'lite' } });
  });

  // テスト用の SSO 設定入力を作るヘルパー
  function input(tenantId: string, enabled = true) {
    return {
      tenantId,
      enabled,
      idpEntityId: `https://idp.example.com/${tenantId}`,
      idpSsoUrl: 'https://idp.example.com/sso',
      idpX509Cert: 'MIIBDUMMYCERT',
    };
  }

  // upsert で作成し findByTenant で取得できる
  it('upsert で作成し findByTenant で取得できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const created = await repos.ssoConfigs.upsert(input(TENANT_A));
    expect(created?.tenantId).toBe(TENANT_A);
    const found = await repos.ssoConfigs.findByTenant(TENANT_A);
    expect(found?.idpEntityId).toBe(`https://idp.example.com/${TENANT_A}`);
  });

  // 同一テナントへの upsert は更新になる (1 テナント 1 設定 = @unique tenantId)
  it('同一テナントへの upsert は重複作成せず更新になる', async () => {
    const repos = buildPrismaRepos(prisma);
    const first = await repos.ssoConfigs.upsert(input(TENANT_A, true));
    const second = await repos.ssoConfigs.upsert(input(TENANT_A, false));
    // 同一レコードの更新なので ID は不変、値だけ変わる
    expect(second?.id).toBe(first?.id);
    expect(second?.enabled).toBe(false);
  });

  // 監査で発見したギャップ対応: expected (CAS) 指定時は、書き込み直前の現在値と一致する
  // ときだけ更新され、一致しなければ null (競合) を返して上書きしないことを実 DB で確認する
  it('expectedが現在値と食い違う場合は更新されずnullを返す (実DB)', async () => {
    const repos = buildPrismaRepos(prisma);
    const current = await repos.ssoConfigs.upsert(input(TENANT_A, true));
    if (!current) throw new Error('seed missing sso config');
    const result = await repos.ssoConfigs.upsert({
      ...input(TENANT_A, false),
      expected: {
        enabled: false, // 実際の現在値 (true) と食い違う誤った期待値
        idpEntityId: current.idpEntityId,
        idpSsoUrl: current.idpSsoUrl,
        idpX509Cert: current.idpX509Cert,
      },
    });
    expect(result).toBeNull();
    const found = await repos.ssoConfigs.findByTenant(TENANT_A);
    expect(found?.enabled).toBe(true);
  });

  // クロステナント分離: A の設定は B から取得・削除できない
  it('テナント A の設定はテナント B から取得・削除できない (クロステナント分離)', async () => {
    const repos = buildPrismaRepos(prisma);
    // A にだけ設定を作る
    await repos.ssoConfigs.upsert(input(TENANT_A));
    // B からは取得できない
    expect(await repos.ssoConfigs.findByTenant(TENANT_B)).toBeNull();
    // B の delete は A に影響しない
    await repos.ssoConfigs.delete(TENANT_B);
    expect(await repos.ssoConfigs.findByTenant(TENANT_A)).not.toBeNull();
  });

  // delete で自テナントの設定を削除できる
  it('delete で自テナントの設定を削除できる', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.ssoConfigs.upsert(input(TENANT_A));
    await repos.ssoConfigs.delete(TENANT_A);
    expect(await repos.ssoConfigs.findByTenant(TENANT_A)).toBeNull();
  });
});
