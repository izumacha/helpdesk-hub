// UserRepository の LINE 紐付けメソッド (メモリアダプタ) の単体テスト。
// findByLineUserId / setLineLinkCode / linkLineUserByCode / unlinkLineUser の挙動と
// テナント分離・冪等・競合 (conflict) を検証する (DB は持ち込まない)。

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
import { hashLineLinkCode, normalizeLineLinkCode } from '@/lib/line-link';

const TENANT = 'default-tenant';
const OTHER_TENANT = 'other-tenant';

let store: Store;
let repos: Repos;

// テスト用メンバーを 1 人ストアに置く小ヘルパー
function putUser(id: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const now = new Date();
  store.users.set(id, {
    id,
    email: `${id}@example.com`,
    name: id,
    passwordHash: 'x',
    role: 'requester',
    tenantId,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
}

// 生コードを正規化してハッシュ化する (発行側と同じ手順)
async function codeHashOf(rawCode: string): Promise<string> {
  return hashLineLinkCode(normalizeLineLinkCode(rawCode));
}

describe('UserRepository LINE 紐付け (memory)', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
  });

  // findByLineUserId: 紐付け済みメンバーを返し、別テナントには漏れない
  it('findByLineUserId はテナントスコープで引く', async () => {
    putUser('u1', TENANT, { lineUserId: 'Uline1' });
    // 同 tenant では引ける
    expect((await repos.users.findByLineUserId(TENANT, 'Uline1'))?.id).toBe('u1');
    // 別 tenant からは見えない (クロステナント漏洩防止)
    expect(await repos.users.findByLineUserId(OTHER_TENANT, 'Uline1')).toBeNull();
    // 未連携の LINE ユーザー ID は null
    expect(await repos.users.findByLineUserId(TENANT, 'UlineX')).toBeNull();
  });

  // setLineLinkCode → linkLineUserByCode で連携が成立し、コードは消費される
  it('発行コードで連携が成立し、コードが消費される', async () => {
    putUser('u1', TENANT);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const hash = await codeHashOf('AB7K-9QF2');
    await repos.users.setLineLinkCode('u1', TENANT, { codeHash: hash, expiresAt });

    const result = await repos.users.linkLineUserByCode({
      codeHash: hash,
      tenantId: TENANT,
      lineUserId: 'Uline1',
      now: new Date(),
    });
    expect(result).toEqual({ status: 'linked', userId: 'u1' });
    // lineUserId が設定され、発行中コードはクリアされている
    const u1 = store.users.get('u1');
    expect(u1?.lineUserId).toBe('Uline1');
    expect(u1?.lineLinkCodeHash).toBeNull();
    // 2 回目 (同じコード) はもう有効な発行行が無いので invalid
    const again = await repos.users.linkLineUserByCode({
      codeHash: hash,
      tenantId: TENANT,
      lineUserId: 'Uline1',
      now: new Date(),
    });
    expect(again.status).toBe('invalid');
  });

  // 失効済みコードは invalid
  it('失効したコードは invalid を返す', async () => {
    putUser('u1', TENANT);
    const hash = await codeHashOf('AB7K-9QF2');
    // 既に失効している有効期限を設定する
    await repos.users.setLineLinkCode('u1', TENANT, {
      codeHash: hash,
      expiresAt: new Date(Date.now() - 1000),
    });
    const result = await repos.users.linkLineUserByCode({
      codeHash: hash,
      tenantId: TENANT,
      lineUserId: 'Uline1',
      now: new Date(),
    });
    expect(result.status).toBe('invalid');
  });

  // 別テナントのコードは取り込み先テナントでは消費できない (クロステナント防止)
  it('別テナントのコードは消費できない', async () => {
    putUser('uOther', OTHER_TENANT);
    const hash = await codeHashOf('AB7K-9QF2');
    await repos.users.setLineLinkCode('uOther', OTHER_TENANT, {
      codeHash: hash,
      expiresAt: new Date(Date.now() + 60_000),
    });
    // TENANT 側で同じハッシュを照合しても一致しない
    const result = await repos.users.linkLineUserByCode({
      codeHash: hash,
      tenantId: TENANT,
      lineUserId: 'Uline1',
      now: new Date(),
    });
    expect(result.status).toBe('invalid');
  });

  // その LINE ユーザー ID が別メンバーに連携済みなら conflict
  it('LINE ユーザー ID が別メンバーに連携済みなら conflict', async () => {
    putUser('u1', TENANT, { lineUserId: 'Uline1' }); // 既に Uline1 を持つ
    putUser('u2', TENANT); // u2 が同じ Uline1 を取りにくる
    const hash = await codeHashOf('ZZ11-2233');
    await repos.users.setLineLinkCode('u2', TENANT, {
      codeHash: hash,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const result = await repos.users.linkLineUserByCode({
      codeHash: hash,
      tenantId: TENANT,
      lineUserId: 'Uline1',
      now: new Date(),
    });
    expect(result.status).toBe('conflict');
    // u2 は連携されないまま
    expect(store.users.get('u2')?.lineUserId).toBeFalsy();
  });

  // unlinkLineUser は lineUserId と発行中コードをまとめてクリアする
  it('unlinkLineUser で連携を解除する', async () => {
    putUser('u1', TENANT, {
      lineUserId: 'Uline1',
      lineLinkCodeHash: 'h',
      lineLinkCodeExpiresAt: new Date(),
    });
    await repos.users.unlinkLineUser('u1', TENANT);
    const u1 = store.users.get('u1');
    expect(u1?.lineUserId).toBeNull();
    expect(u1?.lineLinkCodeHash).toBeNull();
    expect(u1?.lineLinkCodeExpiresAt).toBeNull();
  });
});
