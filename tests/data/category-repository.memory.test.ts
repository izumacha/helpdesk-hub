// カテゴリリポジトリ (メモリアダプタ) の単体テスト。
// 監査で発見したギャップ: CategoryRepository には Port/Prisma/メモリの各アダプタが揃っているのに
// テストが 1 つも無かった (list/findById/create いずれもテナントスコープが必須のメソッドで、
// クロステナント漏洩防止が最重要の検証観点にもかかわらず未検証だった)。

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '@/data/adapters/memory';
import {
  CATEGORY_LIST_LIMIT,
  CATEGORY_LIST_MATCHING_LIMIT,
  resolveCategoryListLimit,
} from '@/data/ports/category-repository';
import type { Repos } from '@/data/ports/unit-of-work';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

let repos: Repos;

beforeEach(() => {
  const ctx = createMemoryContext();
  repos = ctx.repos;
});

describe('CategoryRepository (memory)', () => {
  // create: 新規カテゴリを作成できる
  it('新規カテゴリを作成できる', async () => {
    const category = await repos.categories.create({ name: 'ネットワーク', tenantId: TENANT_A });
    expect(category.name).toBe('ネットワーク');
    expect(category.id).toEqual(expect.any(String));
  });

  // create: 同テナント + 同名は insert or ignore 相当で既存行を返す (Prisma アダプタと挙動を揃える)
  it('同テナント内の同名作成は既存カテゴリを返す (冪等)', async () => {
    const first = await repos.categories.create({ name: 'ハードウェア', tenantId: TENANT_A });
    const second = await repos.categories.create({ name: 'ハードウェア', tenantId: TENANT_A });
    expect(second.id).toBe(first.id);
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
