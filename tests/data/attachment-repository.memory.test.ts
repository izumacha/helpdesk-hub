// 添付メタデータ用リポジトリ (メモリ実装) の単体テスト。
// 主にクロステナント越境の遮断 (tenantId 不一致は null / no-op) を回帰として検証する。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// メモリ版の Composition Root (store + repos + uow)
import { createMemoryContext } from '@/data/adapters/memory';

// 主に使うテナント ID
const TENANT_A = 'tenant-a';
// 越境検証で使う別テナント ID
const TENANT_B = 'tenant-b';

// 添付作成の最低限な雛形 (個別テストで一部を上書きする)
function makeInput(
  overrides: Partial<
    Parameters<ReturnType<typeof createMemoryContext>['repos']['attachments']['create']>[0]
  > = {},
) {
  // テナント A・チケット t-1・ユーザー u-1 を既定値とする
  return {
    ticketId: 't-1',
    commentId: null,
    uploaderId: 'u-1',
    tenantId: TENANT_A,
    mimeType: 'image/jpeg',
    size: 1024,
    originalName: 'photo.jpg',
    storageKey: `${TENANT_A}/t-1/aaaa.jpg`,
    storage: 'local' as const,
    ...overrides,
  };
}

describe('AttachmentRepository (memory adapter)', () => {
  // 1 件作って同じ ID + 同じテナントなら取得できる
  it('create + findById round-trips within the same tenant', async () => {
    const { repos } = createMemoryContext();
    // テナント A に 1 件添付を作る
    const created = await repos.attachments.create(makeInput());
    // 同じ tenantId で取得すると同じ ID が返る
    const found = await repos.attachments.findById(created.id, TENANT_A);
    expect(found?.id).toBe(created.id);
    expect(found?.originalName).toBe('photo.jpg');
  });

  // 他テナントの ID は問答無用で null
  it('findById returns null when tenantId mismatches', async () => {
    const { repos } = createMemoryContext();
    // テナント A に 1 件作成
    const created = await repos.attachments.create(makeInput());
    // テナント B で問い合わせると null になる (クロステナント遮断)
    const found = await repos.attachments.findById(created.id, TENANT_B);
    expect(found).toBeNull();
  });

  // listByTicket は古い順で同テナントのみ返す
  it('listByTicket returns only same-tenant rows in ascending order', async () => {
    const { repos } = createMemoryContext();
    // テナント A に 2 件、テナント B に 1 件 (同じ ticketId) を作る
    const a1 = await repos.attachments.create(makeInput({ originalName: 'a1.jpg' }));
    // 時系列を確実に分けるため 2ms 待つ (Date.now の分解能対策)
    await new Promise((r) => setTimeout(r, 2));
    const a2 = await repos.attachments.create(makeInput({ originalName: 'a2.jpg' }));
    await repos.attachments.create(makeInput({ tenantId: TENANT_B, originalName: 'b1.jpg' }));

    // テナント A から見ると 2 件 (a1, a2) のみ、古い順
    const listA = await repos.attachments.listByTicket('t-1', TENANT_A);
    expect(listA.map((x) => x.id)).toEqual([a1.id, a2.id]);

    // テナント B から見ると別の 1 件しか見えない (a1/a2 は含まれない)
    const listB = await repos.attachments.listByTicket('t-1', TENANT_B);
    expect(listB.map((x) => x.originalName)).toEqual(['b1.jpg']);
  });

  // countByTicket は同テナントのみ数える
  it('countByTicket counts only same-tenant rows', async () => {
    const { repos } = createMemoryContext();
    // テナント A に 2 件、B に 1 件
    await repos.attachments.create(makeInput());
    await repos.attachments.create(makeInput());
    await repos.attachments.create(makeInput({ tenantId: TENANT_B }));
    // A から見ると 2 件
    expect(await repos.attachments.countByTicket('t-1', TENANT_A)).toBe(2);
    // B から見ると 1 件
    expect(await repos.attachments.countByTicket('t-1', TENANT_B)).toBe(1);
  });

  // sumSizeByTenant は同テナントの添付サイズのみ合算する (添付累計サイズ上限チェック用)
  it('sumSizeByTenant sums only same-tenant rows', async () => {
    const { repos } = createMemoryContext();
    // テナント A に 1000 + 2000 バイト、B に 500 バイト
    await repos.attachments.create(makeInput({ size: 1000 }));
    await repos.attachments.create(makeInput({ size: 2000 }));
    await repos.attachments.create(makeInput({ tenantId: TENANT_B, size: 500 }));
    // A から見ると 3000 バイト
    expect(await repos.attachments.sumSizeByTenant(TENANT_A)).toBe(3000);
    // B から見ると 500 バイト
    expect(await repos.attachments.sumSizeByTenant(TENANT_B)).toBe(500);
  });

  // テナントに添付が 1 件も無ければ 0 を返す
  it('sumSizeByTenant returns 0 when the tenant has no attachments', async () => {
    const { repos } = createMemoryContext();
    expect(await repos.attachments.sumSizeByTenant(TENANT_A)).toBe(0);
  });

  // delete は他テナントの ID を渡しても元行を残す
  it('delete is a no-op when tenantId mismatches', async () => {
    const { repos } = createMemoryContext();
    // テナント A に 1 件作成
    const created = await repos.attachments.create(makeInput());
    // テナント B から削除を試みる → 何も起きない
    await repos.attachments.delete(created.id, TENANT_B);
    // テナント A からはまだ取得できる
    expect(await repos.attachments.findById(created.id, TENANT_A)).not.toBeNull();
    // 同テナントからの削除は成功する
    await repos.attachments.delete(created.id, TENANT_A);
    expect(await repos.attachments.findById(created.id, TENANT_A)).toBeNull();
  });
});
