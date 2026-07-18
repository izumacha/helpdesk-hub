// 拠点リポジトリ (Prisma アダプタ) の契約テスト。
// Phase 4 多拠点 (docs/smb-dx-pivot-plan.md §5.2)。テナント分離・重複名エラー・
// 削除時のチケット locationId SetNull カスケードを実 DB に対して検証する。
// 監査で発見したギャップ: これまで tests/data/location-repository.memory.test.ts
// (メモリアダプタ) しかテストが無く、update() の「事前 findFirst でテナント所有を
// 確認してから PK だけで更新する」という非自明な実装や、DB 側の @@unique([tenantId, name])
// 制約・ON DELETE SET NULL カスケードが実際に本番 Prisma アダプタで動くかは未検証だった
// (CLAUDE.md §11「メモリのみのテストは実装の誤った自信を生む」)。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを
// TRUNCATE するため **開発 DB を指さない** こと。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma';
import { buildPrismaRepos } from '@/data/adapters/prisma';
import {
  LOCATION_LIST_LIMIT,
  LOCATION_LIST_MATCHING_LIMIT,
} from '@/data/ports/location-repository';

const TENANT_A = 'default-tenant';
const TENANT_B = 'tenant-b';
const USER_A = 'user-a';

const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('LocationRepository (prisma adapter)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // 各テスト前に全テーブルを空にし、テナント A / B + テナント A のユーザーを作成する
  // (削除時のチケットカスケードテストで Ticket.creatorId の FK 先が必要)
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Location","Attachment","TicketHistory","TicketComment","Notification","FaqCandidate","Ticket","Category","MagicLinkToken","User","Tenant" RESTART IDENTITY CASCADE',
    );
    await prisma.tenant.create({ data: { id: TENANT_A, name: 'デフォルト組織', mode: 'lite' } });
    await prisma.tenant.create({ data: { id: TENANT_B, name: '別組織', mode: 'lite' } });
    await prisma.user.create({
      data: {
        id: USER_A,
        email: 'admin@example.com',
        name: '管理者太郎',
        passwordHash: 'x',
        role: 'admin',
        tenantId: TENANT_A,
      },
    });
  });

  // 新規拠点を作成できる
  it('新規拠点を作成できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const location = await repos.locations.create({
      tenantId: TENANT_A,
      name: '渋谷本店',
      description: '本社',
    });
    expect(location.id).toEqual(expect.any(String));
    expect(location.name).toBe('渋谷本店');
  });

  // 同一テナント内で同名の拠点は作成できない (@@unique([tenantId, name]))
  it('同一テナント内の重複名はエラーになる', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.locations.create({ tenantId: TENANT_A, name: '渋谷本店', description: null });
    await expect(
      repos.locations.create({ tenantId: TENANT_A, name: '渋谷本店', description: null }),
    ).rejects.toThrow();
  });

  // 別テナントであれば同名の拠点を作成できる (一意制約がテナントスコープであること)
  it('別テナントであれば同名でも作成できる', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.locations.create({ tenantId: TENANT_A, name: '渋谷本店', description: null });
    const location = await repos.locations.create({
      tenantId: TENANT_B,
      name: '渋谷本店',
      description: null,
    });
    expect(location.tenantId).toBe(TENANT_B);
  });

  // テナントスコープで絞り込み、他テナントの拠点は含まれない
  it('listByTenantは自テナントの拠点のみを返す', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.locations.create({ tenantId: TENANT_A, name: 'A拠点', description: null });
    await repos.locations.create({ tenantId: TENANT_B, name: 'B拠点', description: null });
    const result = await repos.locations.listByTenant(TENANT_A);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('A拠点');
  });

  // 監査で発見したギャップ対応: 上限件数を超えて作成しても LOCATION_LIST_LIMIT 件までに
  // 切り詰められること (§8 一覧取得は必ず上限を持たせる。実 DB の take が効くことの確認)
  it('listByTenantは上限件数で切り詰める', async () => {
    const repos = buildPrismaRepos(prisma);
    for (let i = 0; i < LOCATION_LIST_LIMIT + 3; i += 1) {
      await repos.locations.create({
        tenantId: TENANT_A,
        name: `拠点${String(i).padStart(4, '0')}`,
        description: null,
      });
    }
    const result = await repos.locations.listByTenant(TENANT_A);
    expect(result).toHaveLength(LOCATION_LIST_LIMIT);
  });

  // 監査で発見したギャップ対応: opts.limit に LOCATION_LIST_MATCHING_LIMIT を明示的に渡すと、
  // 実 DB でも表示用の既定上限を超えて取得できること (CSV インポートの名前解決が依存する経路)
  it('opts.limitを指定すると実DBでも既定上限を超えて取得できる', async () => {
    const repos = buildPrismaRepos(prisma);
    for (let i = 0; i < LOCATION_LIST_LIMIT + 3; i += 1) {
      await repos.locations.create({
        tenantId: TENANT_A,
        name: `拠点${String(i).padStart(4, '0')}`,
        description: null,
      });
    }
    const result = await repos.locations.listByTenant(TENANT_A, {
      limit: LOCATION_LIST_MATCHING_LIMIT,
    });
    expect(result).toHaveLength(LOCATION_LIST_LIMIT + 3);
  });

  // 他テナントの ID を渡すと null を返す (クロステナントアクセス防止)
  it('findByIdは他テナントの拠点IDにnullを返す', async () => {
    const repos = buildPrismaRepos(prisma);
    const location = await repos.locations.create({
      tenantId: TENANT_A,
      name: 'A拠点',
      description: null,
    });
    const result = await repos.locations.findById(location.id, TENANT_B);
    expect(result).toBeNull();
  });

  // 名前・説明を更新できる (update() の findFirst→PKのみ更新パターンの正常系)
  it('名前と説明を更新できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const location = await repos.locations.create({
      tenantId: TENANT_A,
      name: '旧名称',
      description: '旧説明',
    });
    const updated = await repos.locations.update(location.id, TENANT_A, {
      name: '新名称',
      description: '新説明',
    });
    expect(updated.name).toBe('新名称');
    expect(updated.description).toBe('新説明');
  });

  // 他テナントの拠点 ID を更新しようとするとエラーになる (fail-closed)。
  // update() は Prisma の制約上 PK のみで解決するため、事前 findFirst によるテナント
  // 所有確認が実際に機能しているかが本番 Prisma アダプタでの最重要な検証ポイント
  it('他テナントの拠点IDを更新しようとするとエラーになり実際に変更されない', async () => {
    const repos = buildPrismaRepos(prisma);
    const location = await repos.locations.create({
      tenantId: TENANT_A,
      name: 'A拠点',
      description: null,
    });
    await expect(
      repos.locations.update(location.id, TENANT_B, { name: '乗っ取り' }),
    ).rejects.toThrow();
    // 実際にテナント A 側の値が変更されていないことを確認する
    const reloaded = await repos.locations.findById(location.id, TENANT_A);
    expect(reloaded?.name).toBe('A拠点');
  });

  // 存在しない拠点 ID はエラーになる
  it('存在しない拠点IDの更新はエラーになる', async () => {
    const repos = buildPrismaRepos(prisma);
    await expect(
      repos.locations.update('no-such-location', TENANT_A, { name: 'x' }),
    ).rejects.toThrow();
  });

  // 削除すると紐づくチケットの locationId が null になる (DB の ON DELETE SET NULL を検証)
  it('削除すると紐づくチケットのlocationIdがnullになる (ON DELETE SET NULL)', async () => {
    const repos = buildPrismaRepos(prisma);
    const location = await repos.locations.create({
      tenantId: TENANT_A,
      name: 'A拠点',
      description: null,
    });
    const ticket = await repos.tickets.create({
      title: 'テスト',
      body: '本文',
      priority: 'Medium',
      creatorId: USER_A,
      categoryId: null,
      locationId: location.id,
      tenantId: TENANT_A,
    });

    await repos.locations.delete(location.id, TENANT_A);

    const reloaded = await repos.tickets.findById(ticket.id, TENANT_A);
    expect(reloaded?.locationId).toBeNull();
  });

  // 削除された拠点自体はもう取得できない
  it('削除後は拠点自体が取得できなくなる', async () => {
    const repos = buildPrismaRepos(prisma);
    const location = await repos.locations.create({
      tenantId: TENANT_A,
      name: 'A拠点',
      description: null,
    });
    await repos.locations.delete(location.id, TENANT_A);
    const result = await repos.locations.findById(location.id, TENANT_A);
    expect(result).toBeNull();
  });

  // 他テナントの拠点 ID を削除しようとしても no-op (deleteMany の想定挙動)
  it('他テナントの拠点IDを削除しようとしてもno-opになる', async () => {
    const repos = buildPrismaRepos(prisma);
    const location = await repos.locations.create({
      tenantId: TENANT_A,
      name: 'A拠点',
      description: null,
    });
    await repos.locations.delete(location.id, TENANT_B);
    // テナント A から見ればまだ存在しているはず
    const result = await repos.locations.findById(location.id, TENANT_A);
    expect(result).not.toBeNull();
  });
});
