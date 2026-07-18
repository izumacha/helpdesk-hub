// カテゴリリポジトリ (Prisma アダプタ) の契約テスト。
// 監査で発見したギャップ: tests/data/category-repository.memory.test.ts (メモリアダプタ) しか
// テストが無く、create() の upsert (tenantId_name 複合一意キーによる insert-or-ignore) が
// 本番 Prisma アダプタで実際に冪等に動くかは未検証だった (CLAUDE.md §11)。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを
// TRUNCATE するため **開発 DB を指さない** こと。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma';
import { buildPrismaRepos } from '@/data/adapters/prisma';
import { CATEGORY_LIST_LIMIT } from '@/data/ports/category-repository';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('CategoryRepository (prisma adapter)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Location","Attachment","TicketHistory","TicketComment","Notification","FaqCandidate","Ticket","Category","MagicLinkToken","User","Tenant" RESTART IDENTITY CASCADE',
    );
    await prisma.tenant.create({ data: { id: TENANT_A, name: 'テナントA', mode: 'lite' } });
    await prisma.tenant.create({ data: { id: TENANT_B, name: 'テナントB', mode: 'lite' } });
  });

  // 新規カテゴリを作成できる
  it('新規カテゴリを作成できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const category = await repos.categories.create({ name: 'ネットワーク', tenantId: TENANT_A });
    expect(category.name).toBe('ネットワーク');
  });

  // create: 同テナント + 同名の再作成は upsert で冪等に動く (P2002 にならず既存行を返す)
  it('同テナント内の同名作成はupsertで冪等に動く', async () => {
    const repos = buildPrismaRepos(prisma);
    const first = await repos.categories.create({ name: 'ハードウェア', tenantId: TENANT_A });
    const second = await repos.categories.create({ name: 'ハードウェア', tenantId: TENANT_A });
    expect(second.id).toBe(first.id);
    // DB 上も 1 件しか無いこと
    const count = await prisma.category.count({ where: { tenantId: TENANT_A } });
    expect(count).toBe(1);
  });

  // 別テナントであれば同名でも作成できる (一意制約はテナントスコープ)
  it('別テナントであれば同名でも作成できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const a = await repos.categories.create({ name: 'ソフトウェア', tenantId: TENANT_A });
    const b = await repos.categories.create({ name: 'ソフトウェア', tenantId: TENANT_B });
    expect(b.id).not.toBe(a.id);
    // テナント B から findById できること (実際に別テナントの行として作られたことの確認)
    expect(await repos.categories.findById(b.id, TENANT_B)).not.toBeNull();
  });

  // list: テナントスコープで絞り込み、名前昇順で返す
  it('listは自テナントのカテゴリのみ名前順で返す', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.categories.create({ name: 'は行', tenantId: TENANT_A });
    await repos.categories.create({ name: 'あ行', tenantId: TENANT_A });
    await repos.categories.create({ name: '他テナント', tenantId: TENANT_B });
    const result = await repos.categories.list(TENANT_A);
    expect(result.map((c) => c.name)).toEqual(['あ行', 'は行']);
  });

  // findById: 他テナントの ID は null (クロステナント漏洩防止)
  it('findByIdは他テナントのIDにnullを返す', async () => {
    const repos = buildPrismaRepos(prisma);
    const category = await repos.categories.create({ name: 'A拠点用', tenantId: TENANT_A });
    const result = await repos.categories.findById(category.id, TENANT_B);
    expect(result).toBeNull();
  });

  // 監査で発見したギャップ対応: 上限件数を超えて作成しても CATEGORY_LIST_LIMIT 件までに
  // 切り詰められること (§8 一覧取得は必ず上限を持たせる。実 DB の take が効くことの確認)
  it('listは上限件数で切り詰める', async () => {
    const repos = buildPrismaRepos(prisma);
    for (let i = 0; i < CATEGORY_LIST_LIMIT + 3; i += 1) {
      await repos.categories.create({
        name: `カテゴリ${String(i).padStart(4, '0')}`,
        tenantId: TENANT_A,
      });
    }
    const result = await repos.categories.list(TENANT_A);
    expect(result).toHaveLength(CATEGORY_LIST_LIMIT);
  });
});
