// 拠点リポジトリ (メモリアダプタ) の単体テスト。
// Phase 4 多拠点 (docs/smb-dx-pivot-plan.md §5.2)。テナント分離・重複名エラー・
// 削除時のチケット locationId SetNull カスケードを検証する
// (これまでテストが 1 件も無く、カスケード処理の回帰が検出できない状態だった)。

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import {
  LOCATION_LIST_LIMIT,
  LOCATION_LIST_MATCHING_LIMIT,
  resolveLocationListLimit,
} from '@/data/ports/location-repository';
import type { Repos } from '@/data/ports/unit-of-work';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

let store: Store;
let repos: Repos;

// テナント内にチケットを 1 件、指定の locationId で投入する
function seedTicket(id: string, tenantId: string, locationId: string | null) {
  const now = new Date();
  store.tickets.set(id, {
    id,
    title: 'テストチケット',
    body: '本文',
    status: 'Open',
    priority: 'Medium',
    createdAt: now,
    updatedAt: now,
    firstResponseDueAt: null,
    resolutionDueAt: null,
    firstRespondedAt: null,
    resolvedAt: null,
    escalatedAt: null,
    escalationReason: null,
    slaReminderNotifiedForDueAt: null,
    creatorId: 'creator-1',
    assigneeId: null,
    categoryId: null,
    locationId,
    tenantId,
  });
}

beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
});

describe('LocationRepository.create (memory)', () => {
  // 新規拠点を作成できる
  it('新規拠点を作成できる', async () => {
    const location = await repos.locations.create({
      tenantId: TENANT_A,
      name: '渋谷本店',
      description: '本社',
    });
    expect(location.id).toEqual(expect.any(String));
    expect(location.name).toBe('渋谷本店');
  });

  // 同一テナント内で同名の拠点は作成できない (一意制約相当)
  it('同一テナント内の重複名はエラーになる', async () => {
    await repos.locations.create({ tenantId: TENANT_A, name: '渋谷本店', description: null });
    await expect(
      repos.locations.create({ tenantId: TENANT_A, name: '渋谷本店', description: null }),
    ).rejects.toThrow();
  });

  // 別テナントであれば同名の拠点を作成できる (テナントスコープの重複チェック)
  it('別テナントであれば同名でも作成できる', async () => {
    await repos.locations.create({ tenantId: TENANT_A, name: '渋谷本店', description: null });
    const location = await repos.locations.create({
      tenantId: TENANT_B,
      name: '渋谷本店',
      description: null,
    });
    expect(location.tenantId).toBe(TENANT_B);
  });
});

describe('LocationRepository.listByTenant (memory)', () => {
  // テナントスコープで絞り込み、他テナントの拠点は含まれない
  it('自テナントの拠点のみを返す', async () => {
    await repos.locations.create({ tenantId: TENANT_A, name: 'A拠点', description: null });
    await repos.locations.create({ tenantId: TENANT_B, name: 'B拠点', description: null });
    const result = await repos.locations.listByTenant(TENANT_A);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('A拠点');
  });

  // 監査で発見したギャップ対応: 上限件数を超えて作成しても LOCATION_LIST_LIMIT 件までに
  // 切り詰められること (§8 一覧取得は必ず上限を持たせる)
  it('上限件数で切り詰める', async () => {
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
  // 表示用の既定上限 (LOCATION_LIST_LIMIT) を超えて取得できること (CSV インポートの名前解決が
  // これに依存する)
  it('opts.limitを指定すると既定上限を超えて取得できる', async () => {
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
});

// resolveLocationListLimit (呼び出し元の指定値をクランプする純粋関数) の単体テスト。
// アダプタ層の多層防御クランプが正しく機能することを、実データを介さず直接検証する
// (resolveFaqListLimit と同じ「アダプタ経由ではなく関数自体を直接テストする」方針)
describe('resolveLocationListLimit', () => {
  // 未指定 (undefined) なら表示用の既定上限 (LOCATION_LIST_LIMIT) を返す
  it('未指定ならLOCATION_LIST_LIMITを返す', () => {
    expect(resolveLocationListLimit(undefined)).toBe(LOCATION_LIST_LIMIT);
  });

  // 指定値が LOCATION_LIST_MATCHING_LIMIT 以下ならそのまま返す
  it('LOCATION_LIST_MATCHING_LIMIT以下ならそのまま返す', () => {
    expect(resolveLocationListLimit(LOCATION_LIST_MATCHING_LIMIT)).toBe(
      LOCATION_LIST_MATCHING_LIMIT,
    );
  });

  // 指定値が LOCATION_LIST_MATCHING_LIMIT を超えるとクランプされる
  it('LOCATION_LIST_MATCHING_LIMITを超えるとクランプされる', () => {
    expect(resolveLocationListLimit(LOCATION_LIST_MATCHING_LIMIT + 1000)).toBe(
      LOCATION_LIST_MATCHING_LIMIT,
    );
  });
});

describe('LocationRepository.findById (memory)', () => {
  // 他テナントの ID を渡すと null を返す (クロステナントアクセス防止)
  it('他テナントの拠点IDはnullを返す', async () => {
    const location = await repos.locations.create({
      tenantId: TENANT_A,
      name: 'A拠点',
      description: null,
    });
    const result = await repos.locations.findById(location.id, TENANT_B);
    expect(result).toBeNull();
  });
});

describe('LocationRepository.update (memory)', () => {
  // 名前・説明を更新できる
  it('名前と説明を更新できる', async () => {
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

  // 他テナントの拠点 ID を更新しようとするとエラーになる (fail-closed)
  it('他テナントの拠点IDを更新しようとするとエラーになる', async () => {
    const location = await repos.locations.create({
      tenantId: TENANT_A,
      name: 'A拠点',
      description: null,
    });
    await expect(
      repos.locations.update(location.id, TENANT_B, { name: '乗っ取り' }),
    ).rejects.toThrow();
  });

  // 存在しない拠点 ID はエラーになる
  it('存在しない拠点IDはエラーになる', async () => {
    await expect(
      repos.locations.update('no-such-location', TENANT_A, { name: 'x' }),
    ).rejects.toThrow();
  });
});

describe('LocationRepository.delete (memory)', () => {
  // 削除すると紐づくチケットの locationId が null になる (ON DELETE SET NULL 相当)
  it('削除すると紐づくチケットのlocationIdがnullになる', async () => {
    const location = await repos.locations.create({
      tenantId: TENANT_A,
      name: 'A拠点',
      description: null,
    });
    seedTicket('ticket-1', TENANT_A, location.id);
    seedTicket('ticket-2', TENANT_A, location.id);

    await repos.locations.delete(location.id, TENANT_A);

    expect(store.tickets.get('ticket-1')?.locationId).toBeNull();
    expect(store.tickets.get('ticket-2')?.locationId).toBeNull();
  });

  // 削除された拠点自体はもう取得できない
  it('削除後は拠点自体が取得できなくなる', async () => {
    const location = await repos.locations.create({
      tenantId: TENANT_A,
      name: 'A拠点',
      description: null,
    });
    await repos.locations.delete(location.id, TENANT_A);
    const result = await repos.locations.findById(location.id, TENANT_A);
    expect(result).toBeNull();
  });

  // 他テナントの拠点と紐づくチケットは影響を受けない
  it('他テナントのチケットのlocationIdには影響しない', async () => {
    const locationA = await repos.locations.create({
      tenantId: TENANT_A,
      name: 'A拠点',
      description: null,
    });
    const locationB = await repos.locations.create({
      tenantId: TENANT_B,
      name: 'B拠点',
      description: null,
    });
    seedTicket('ticket-b', TENANT_B, locationB.id);

    await repos.locations.delete(locationA.id, TENANT_A);

    // テナント B のチケットは無関係なので locationId が維持される
    expect(store.tickets.get('ticket-b')?.locationId).toBe(locationB.id);
  });

  // 他テナントの拠点 ID を削除しようとしても no-op (Prisma の deleteMany と同じ挙動)
  it('他テナントの拠点IDを削除しようとしてもno-opになる', async () => {
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
