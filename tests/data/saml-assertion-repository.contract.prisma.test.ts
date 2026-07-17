// SAML アサーションのリプレイ防止記録リポジトリ (本番 Prisma 実装) の契約テスト。
// (tenantId, assertionId) の初回記録・2回目以降の拒否・クロステナント分離 (§9) を実 DB で検証する。
// RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを TRUNCATE するため
// **開発 DB を指さないこと** (CLAUDE.md §テスト)。専用 DB で実行する。

// Vitest の DSL とフック
import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
// Prisma クライアント本体 (生成物)
import { PrismaClient } from '@/generated/prisma';
// 本番 Prisma 実装の repos 束を組み立てる関数
import { buildPrismaRepos } from '@/data/adapters/prisma';

// テナント A / B の ID
const TENANT_A = 'default-tenant';
const TENANT_B = 'tenant-b';

// DB 依存テストを実行してよいかの明示フラグ (CI の専用ジョブだけが '1' を立てる)
const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('SamlAssertionRef prisma adapter', () => {
  // スイート全体で共有する PrismaClient
  let prisma: PrismaClient;

  // スイート開始時に 1 度だけ接続する
  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  // スイート終了時に接続を閉じる (接続リーク防止)
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // 各テスト前に全テーブルを空にし、テナント A/B をシードする。
  // SamlAssertionRef は Tenant への CASCADE FK があるため、Tenant TRUNCATE で連鎖的に消える。
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "SamlAssertionRef","Tenant" RESTART IDENTITY CASCADE',
    );
    await prisma.tenant.create({ data: { id: TENANT_A, name: 'デフォルト組織', mode: 'lite' } });
    await prisma.tenant.create({ data: { id: TENANT_B, name: '別組織', mode: 'lite' } });
  });

  // 初回利用は記録され true が返る
  it('初回利用は記録して true を返す', async () => {
    const repos = buildPrismaRepos(prisma);
    const result = await repos.samlAssertions.recordIfNew({
      tenantId: TENANT_A,
      assertionId: '_a1',
    });
    expect(result).toBe(true);
    expect(await prisma.samlAssertionRef.count()).toBe(1);
  });

  // 同一 (tenantId, assertionId) の2回目は false (一意制約違反をリプレイとして検知)
  it('同一アサーションの2回目は false を返し新規記録しない', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.samlAssertions.recordIfNew({ tenantId: TENANT_A, assertionId: '_a1' });
    const second = await repos.samlAssertions.recordIfNew({
      tenantId: TENANT_A,
      assertionId: '_a1',
    });
    expect(second).toBe(false);
    expect(await prisma.samlAssertionRef.count()).toBe(1);
  });

  // 別テナントであれば同じ assertionId でも独立して初回扱いになる ((tenantId, assertionId) 複合一意のため)
  it('テナントが違えば同一 assertionId を別々に記録できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const forA = await repos.samlAssertions.recordIfNew({
      tenantId: TENANT_A,
      assertionId: 'same',
    });
    const forB = await repos.samlAssertions.recordIfNew({
      tenantId: TENANT_B,
      assertionId: 'same',
    });
    expect(forA).toBe(true);
    expect(forB).toBe(true);
    expect(await prisma.samlAssertionRef.count()).toBe(2);
  });

  // 同時に同じアサーションを記録しようとしても、DB の一意制約により片方だけが true になる
  it('同時実行でも一意制約により片方だけが初回利用と判定される', async () => {
    const repos = buildPrismaRepos(prisma);
    const results = await Promise.all([
      repos.samlAssertions.recordIfNew({ tenantId: TENANT_A, assertionId: 'race' }),
      repos.samlAssertions.recordIfNew({ tenantId: TENANT_A, assertionId: 'race' }),
    ]);
    // ちょうど 1 件だけ true (初回利用)
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await prisma.samlAssertionRef.count()).toBe(1);
  });
});
