// カテゴリリポジトリ (メモリアダプタ) の単体テスト。
// 監査で発見したギャップ: CategoryRepository には Port/Prisma/メモリの各アダプタが揃っているのに
// テストが 1 つも無かった (list/findById/create いずれもテナントスコープが必須のメソッドで、
// クロステナント漏洩防止が最重要の検証観点にもかかわらず未検証だった)。
//
// フォローアップ (2026-07-21): admin による CRUD (create/update/delete) を追加した際、
// create() の契約を upsert (冪等) から plain create (重複は throw) に変更したため、
// 既存の「冪等」テストを LocationRepository と同じ「重複はエラー」の期待値に更新し、
// update/delete のテストを追加した。

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import {
  CATEGORY_LIST_LIMIT,
  CATEGORY_LIST_MATCHING_LIMIT,
  resolveCategoryListLimit,
} from '@/data/ports/category-repository';
import type { Repos } from '@/data/ports/unit-of-work';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

let store: Store;
let repos: Repos;

// テナント内にチケットを 1 件、指定の categoryId で投入する (delete のカスケード検証用)
function seedTicket(id: string, tenantId: string, categoryId: string | null) {
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
    categoryId,
    locationId: null,
    tenantId,
  });
}

beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
});

describe('CategoryRepository (memory)', () => {
  // create: 新規カテゴリを作成できる
  it('新規カテゴリを作成できる', async () => {
    const category = await repos.categories.create({ name: 'ネットワーク', tenantId: TENANT_A });
    expect(category.name).toBe('ネットワーク');
    expect(category.id).toEqual(expect.any(String));
  });

  // create: 同一テナント内の同名カテゴリはエラーになる (一意制約相当。LocationRepository と同じ契約)
  it('同一テナント内の重複名はエラーになる', async () => {
    await repos.categories.create({ name: 'ハードウェア', tenantId: TENANT_A });
    await expect(
      repos.categories.create({ name: 'ハードウェア', tenantId: TENANT_A }),
    ).rejects.toThrow();
  });

  // create: 別テナントであれば同名でも別行として作成される (一意制約はテナントスコープ)
  it('別テナントであれば同名でも別カテゴリになる', async () => {
    const a = await repos.categories.create({ name: 'ソフトウェア', tenantId: TENANT_A });
    const b = await repos.categories.create({ name: 'ソフトウェア', tenantId: TENANT_B });
    expect(b.id).not.toBe(a.id);
  });

  // list: テナントスコープで絞り込み、名前の昇順で返す
  it('listは自テナントのカテゴリのみ名前順で返す', async () => {
    await repos.categories.create({ name: 'は行', tenantId: TENANT_A });
    await repos.categories.create({ name: 'あ行', tenantId: TENANT_A });
    await repos.categories.create({ name: '他テナント', tenantId: TENANT_B });
    const result = await repos.categories.list(TENANT_A);
    expect(result.map((c) => c.name)).toEqual(['あ行', 'は行']);
  });

  // findById: 他テナントの ID は null (クロステナント漏洩防止)
  it('findByIdは他テナントのIDにnullを返す', async () => {
    const category = await repos.categories.create({ name: 'A拠点用', tenantId: TENANT_A });
    const result = await repos.categories.findById(category.id, TENANT_B);
    expect(result).toBeNull();
  });

  // findById: 存在しない ID は null
  it('findByIdは存在しないIDにnullを返す', async () => {
    const result = await repos.categories.findById('no-such-category', TENANT_A);
    expect(result).toBeNull();
  });

  // 監査で発見したギャップ対応: 上限件数を超えて作成しても CATEGORY_LIST_LIMIT 件までに
  // 切り詰められること (§8 一覧取得は必ず上限を持たせる)
  it('listは上限件数で切り詰める', async () => {
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
  // 表示用の既定上限 (CATEGORY_LIST_LIMIT) を超えて取得できること (CSV インポートの名前解決が
  // これに依存する)
  it('opts.limitを指定すると既定上限を超えて取得できる', async () => {
    for (let i = 0; i < CATEGORY_LIST_LIMIT + 3; i += 1) {
      await repos.categories.create({
        name: `カテゴリ${String(i).padStart(4, '0')}`,
        tenantId: TENANT_A,
      });
    }
    const result = await repos.categories.list(TENANT_A, { limit: CATEGORY_LIST_MATCHING_LIMIT });
    expect(result).toHaveLength(CATEGORY_LIST_LIMIT + 3);
  });
});

// resolveCategoryListLimit (呼び出し元の指定値をクランプする純粋関数) の単体テスト。
describe('resolveCategoryListLimit', () => {
  // 未指定 (undefined) なら表示用の既定上限 (CATEGORY_LIST_LIMIT) を返す
  it('未指定ならCATEGORY_LIST_LIMITを返す', () => {
    expect(resolveCategoryListLimit(undefined)).toBe(CATEGORY_LIST_LIMIT);
  });

  // 指定値が CATEGORY_LIST_MATCHING_LIMIT 以下ならそのまま返す
  it('CATEGORY_LIST_MATCHING_LIMIT以下ならそのまま返す', () => {
    expect(resolveCategoryListLimit(CATEGORY_LIST_MATCHING_LIMIT)).toBe(
      CATEGORY_LIST_MATCHING_LIMIT,
    );
  });

  // 指定値が CATEGORY_LIST_MATCHING_LIMIT を超えるとクランプされる
  it('CATEGORY_LIST_MATCHING_LIMITを超えるとクランプされる', () => {
    expect(resolveCategoryListLimit(CATEGORY_LIST_MATCHING_LIMIT + 1000)).toBe(
      CATEGORY_LIST_MATCHING_LIMIT,
    );
  });
});

describe('CategoryRepository.update (memory)', () => {
  // 名前を更新できる
  it('名前を更新できる', async () => {
    const category = await repos.categories.create({ name: '旧名称', tenantId: TENANT_A });
    const updated = await repos.categories.update(category.id, TENANT_A, { name: '新名称' });
    // expected 未指定の無条件更新なので null にはならない
    expect(updated?.name).toBe('新名称');
  });

  // expected (CAS) 省略時は従来どおり無条件更新、指定時は読み取り時点の値と一致するときだけ更新する
  it('expectedが現在値と一致しない場合は更新せずnullを返す', async () => {
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

  // expected が現在値と一致すれば更新される
  it('expectedが現在値と一致すれば更新できる', async () => {
    const category = await repos.categories.create({ name: '現在の名前', tenantId: TENANT_A });
    const result = await repos.categories.update(
      category.id,
      TENANT_A,
      { name: '新しい名前' },
      { name: '現在の名前' },
    );
    expect(result?.name).toBe('新しい名前');
  });

  // リネーム先が同テナントの別カテゴリと重複する場合はエラーになる
  it('リネーム先が重複する場合はエラーになる', async () => {
    await repos.categories.create({ name: '既存カテゴリ', tenantId: TENANT_A });
    const category = await repos.categories.create({
      name: '変更したいカテゴリ',
      tenantId: TENANT_A,
    });
    await expect(
      repos.categories.update(category.id, TENANT_A, { name: '既存カテゴリ' }),
    ).rejects.toThrow();
  });

  // 他テナントのカテゴリ ID を更新しようとするとエラーになる (fail-closed)
  it('他テナントのカテゴリIDを更新しようとするとエラーになる', async () => {
    const category = await repos.categories.create({ name: 'Aカテゴリ', tenantId: TENANT_A });
    await expect(
      repos.categories.update(category.id, TENANT_B, { name: '乗っ取り' }),
    ).rejects.toThrow();
  });

  // 存在しないカテゴリ ID はエラーになる
  it('存在しないカテゴリIDはエラーになる', async () => {
    await expect(
      repos.categories.update('no-such-category', TENANT_A, { name: 'x' }),
    ).rejects.toThrow();
  });
});

describe('CategoryRepository.delete (memory)', () => {
  // 削除すると紐づくチケットの categoryId が null になる (ON DELETE SetNull 相当)
  it('削除すると紐づくチケットのcategoryIdがnullになる', async () => {
    const category = await repos.categories.create({ name: 'Aカテゴリ', tenantId: TENANT_A });
    seedTicket('ticket-1', TENANT_A, category.id);
    seedTicket('ticket-2', TENANT_A, category.id);

    await repos.categories.delete(category.id, TENANT_A);

    expect(store.tickets.get('ticket-1')?.categoryId).toBeNull();
    expect(store.tickets.get('ticket-2')?.categoryId).toBeNull();
  });

  // 削除された拠点自体はもう取得できない
  it('削除後はカテゴリ自体が取得できなくなる', async () => {
    const category = await repos.categories.create({ name: 'Aカテゴリ', tenantId: TENANT_A });
    await repos.categories.delete(category.id, TENANT_A);
    const result = await repos.categories.findById(category.id, TENANT_A);
    expect(result).toBeNull();
  });

  // 他テナントのカテゴリ ID を削除しようとしても no-op (Prisma の deleteMany と同じ挙動)
  it('他テナントのカテゴリIDを削除しようとしてもno-opになる', async () => {
    const category = await repos.categories.create({ name: 'Aカテゴリ', tenantId: TENANT_A });
    await repos.categories.delete(category.id, TENANT_B);
    const result = await repos.categories.findById(category.id, TENANT_A);
    expect(result).not.toBeNull();
  });
});
