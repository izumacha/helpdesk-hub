// カテゴリリポジトリ (メモリアダプタ) の単体テスト。
// 監査で発見したギャップ: CategoryRepository には Port/Prisma/メモリの各アダプタが揃っているのに
// テストが 1 つも無かった (list/findById/create いずれもテナントスコープが必須のメソッドで、
// クロステナント漏洩防止が最重要の検証観点にもかかわらず未検証だった)。

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '@/data/adapters/memory';
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
});
