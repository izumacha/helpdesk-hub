// AI FAQ 自己解決の計測記録リポジトリ (Prisma アダプタ) の契約テスト (§4.29)。
// updateMany によるテナント + 本人 + 期待状態 (CAS) スコープの更新が本番 Prisma アダプタで
// 実際に動くこと、クロステナント分離が効くことを検証する (CLAUDE.md §11)。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを
// TRUNCATE するため **開発 DB を指さない** こと。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma';
// Prisma 7 はドライバアダプタ必須。生成は共通ファクトリへ寄せる
import { createPrismaClient } from '@/lib/prisma-client';
import { buildPrismaRepos } from '@/data/adapters/prisma';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const USER_A = 'user-a';

const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('DeflectionEventRepository (prisma adapter)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // 関連テーブルをまとめて初期化する (Tenant の CASCADE で DeflectionEvent も消える)
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "DeflectionEvent","Ticket","User","Tenant" RESTART IDENTITY CASCADE',
    );
    await prisma.tenant.create({ data: { id: TENANT_A, name: 'テナントA', mode: 'pro' } });
    await prisma.tenant.create({ data: { id: TENANT_B, name: 'テナントB', mode: 'pro' } });
  });

  // 記録を作成する共通ヘルパー
  async function createSuggested(userId = USER_A) {
    const repos = buildPrismaRepos(prisma);
    return repos.deflectionEvents.create({
      tenantId: TENANT_A,
      userId,
      outcome: 'suggested',
      candidateCount: 3,
      matchedFaqId: 'faq-1',
      model: 'test-model',
    });
  }

  it('記録を作成し、テナントスコープで取得できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const created = await createSuggested();
    // 作成結果に入力値が反映されている
    expect(created).toMatchObject({
      tenantId: TENANT_A,
      userId: USER_A,
      outcome: 'suggested',
      candidateCount: 3,
      matchedFaqId: 'faq-1',
      ticketId: null,
      model: 'test-model',
    });
    // 自テナントからは取得できる
    expect((await repos.deflectionEvents.findById(created.id, TENANT_A))?.id).toBe(created.id);
    // 他テナントからは null (クロステナント分離)
    expect(await repos.deflectionEvents.findById(created.id, TENANT_B)).toBeNull();
  });

  it('updateOutcome は suggested からのみ更新し、二重更新を拒否する', async () => {
    const repos = buildPrismaRepos(prisma);
    const created = await createSuggested();
    // suggested → resolved は成功
    expect(
      await repos.deflectionEvents.updateOutcome(
        created.id,
        { from: 'suggested', to: 'resolved' },
        { tenantId: TENANT_A, userId: USER_A },
        null,
      ),
    ).toBe(true);
    expect((await repos.deflectionEvents.findById(created.id, TENANT_A))?.outcome).toBe('resolved');
    // 既に決着済みなので proceeded への上書きは失敗する (CAS)
    expect(
      await repos.deflectionEvents.updateOutcome(
        created.id,
        { from: 'suggested', to: 'proceeded' },
        { tenantId: TENANT_A, userId: USER_A },
        'ticket-x',
      ),
    ).toBe(false);
    expect((await repos.deflectionEvents.findById(created.id, TENANT_A))?.outcome).toBe('resolved');
  });

  it('updateOutcome は他テナント・他人の記録に対して no-op になる', async () => {
    const repos = buildPrismaRepos(prisma);
    const created = await createSuggested();
    // 他テナントとしての更新は 0 件
    expect(
      await repos.deflectionEvents.updateOutcome(
        created.id,
        { from: 'suggested', to: 'resolved' },
        { tenantId: TENANT_B, userId: USER_A },
        null,
      ),
    ).toBe(false);
    // 他人としての更新も 0 件
    expect(
      await repos.deflectionEvents.updateOutcome(
        created.id,
        { from: 'suggested', to: 'resolved' },
        { tenantId: TENANT_A, userId: 'someone-else' },
        null,
      ),
    ).toBe(false);
    // 状態は変わっていない
    expect((await repos.deflectionEvents.findById(created.id, TENANT_A))?.outcome).toBe(
      'suggested',
    );
  });

  it('proceeded ではチケット ID を紐づける', async () => {
    const repos = buildPrismaRepos(prisma);
    const created = await createSuggested();
    expect(
      await repos.deflectionEvents.updateOutcome(
        created.id,
        { from: 'suggested', to: 'proceeded' },
        { tenantId: TENANT_A, userId: USER_A },
        'ticket-1',
      ),
    ).toBe(true);
    expect(await repos.deflectionEvents.findById(created.id, TENANT_A)).toMatchObject({
      outcome: 'proceeded',
      ticketId: 'ticket-1',
    });
  });
});
