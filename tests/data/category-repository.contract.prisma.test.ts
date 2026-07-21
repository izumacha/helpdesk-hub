// カテゴリリポジトリ (Prisma アダプタ) の契約テスト。
// 監査で発見したギャップ: tests/data/category-repository.memory.test.ts (メモリアダプタ) しか
// テストが無く、create() が本番 Prisma アダプタで実際に一意制約違反を throw するかは未検証だった
// (CLAUDE.md §11)。
//
// フォローアップ (2026-07-21): admin による CRUD (create/update/delete) を追加した際、
// create() の契約を upsert (冪等) から plain create (重複は throw) に変更したため、
// 既存の「upsert で冪等」テストを LocationRepository と同じ「重複はエラー」の期待値に更新し、
// update/delete のテストを追加した。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを
// TRUNCATE するため **開発 DB を指さない** こと。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma';
import { buildPrismaRepos } from '@/data/adapters/prisma';
import {
  CATEGORY_LIST_LIMIT,
  CATEGORY_LIST_MATCHING_LIMIT,
} from '@/data/ports/category-repository';

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

  // create: 同一テナント内の同名カテゴリはエラーになる (一意制約違反。LocationRepository と同じ契約)
  it('同一テナント内の重複名はエラーになる', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.categories.create({ name: 'ハードウェア', tenantId: TENANT_A });
    await expect(
      repos.categories.create({ name: 'ハードウェア', tenantId: TENANT_A }),
    ).rejects.toThrow();
    // DB 上も 1 件しか無いこと (失敗した 2 回目は作成されていない)
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

  // 監査で発見したギャップ対応: opts.limit に CATEGORY_LIST_MATCHING_LIMIT を明示的に渡すと、
  // 実 DB でも表示用の既定上限を超えて取得できること (CSV インポートの名前解決が依存する経路)
  it('opts.limitを指定すると実DBでも既定上限を超えて取得できる', async () => {
    const repos = buildPrismaRepos(prisma);
    for (let i = 0; i < CATEGORY_LIST_LIMIT + 3; i += 1) {
      await repos.categories.create({
        name: `カテゴリ${String(i).padStart(4, '0')}`,
        tenantId: TENANT_A,
      });
    }
    const result = await repos.categories.list(TENANT_A, { limit: CATEGORY_LIST_MATCHING_LIMIT });
    expect(result).toHaveLength(CATEGORY_LIST_LIMIT + 3);
  });

  // update: 名前を更新できる (実 DB での無条件更新)
  it('名前を更新できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const category = await repos.categories.create({ name: '旧名称', tenantId: TENANT_A });
    const updated = await repos.categories.update(category.id, TENANT_A, { name: '新名称' });
    expect(updated?.name).toBe('新名称');
  });

  // update: expected (CAS) が現在値と一致しない場合は更新せず null を返す
  it('expectedが現在値と一致しない場合は更新せずnullを返す', async () => {
    const repos = buildPrismaRepos(prisma);
    const category = await repos.categories.create({ name: '現在の名前', tenantId: TENANT_A });
    const result = await repos.categories.update(
      category.id,
      TENANT_A,
      { name: '新しい名前' },
      { name: '食い違う古い名前' },
    );
    expect(result).toBeNull();
    const found = await repos.categories.findById(category.id, TENANT_A);
    expect(found?.name).toBe('現在の名前');
  });

  // update: 他テナントのカテゴリ ID を更新しようとするとエラーになる (fail-closed)
  it('他テナントのカテゴリIDを更新しようとするとエラーになる', async () => {
    const repos = buildPrismaRepos(prisma);
    const category = await repos.categories.create({ name: 'Aカテゴリ', tenantId: TENANT_A });
    await expect(
      repos.categories.update(category.id, TENANT_B, { name: '乗っ取り' }),
    ).rejects.toThrow();
  });

  // delete: 削除すると紐づくチケットの categoryId が null になる (ON DELETE SetNull)
  it('削除すると紐づくチケットのcategoryIdがnullになる', async () => {
    const repos = buildPrismaRepos(prisma);
    const category = await repos.categories.create({ name: 'Aカテゴリ', tenantId: TENANT_A });
    const creator = await prisma.user.create({
      data: {
        email: 'creator@example.com',
        name: '起票者',
        passwordHash: 'x',
        role: 'requester',
        tenantId: TENANT_A,
      },
    });
    const ticket = await prisma.ticket.create({
      data: {
        title: 'テストチケット',
        body: '本文',
        status: 'Open',
        priority: 'Medium',
        creatorId: creator.id,
        categoryId: category.id,
        tenantId: TENANT_A,
      },
    });

    await repos.categories.delete(category.id, TENANT_A);

    const reloaded = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(reloaded.categoryId).toBeNull();
  });

  // delete: 他テナントのカテゴリ ID を削除しようとしても no-op (Prisma の deleteMany と同じ挙動)
  it('他テナントのカテゴリIDを削除しようとしてもno-opになる', async () => {
    const repos = buildPrismaRepos(prisma);
    const category = await repos.categories.create({ name: 'Aカテゴリ', tenantId: TENANT_A });
    await repos.categories.delete(category.id, TENANT_B);
    const result = await repos.categories.findById(category.id, TENANT_A);
    expect(result).not.toBeNull();
  });
});
