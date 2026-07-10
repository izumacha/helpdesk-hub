// チケット履歴リポジトリ (メモリアダプタ) の単体テスト。
// 監査で発見したギャップ: TicketHistoryRepository には Port/Prisma/メモリの各アダプタが揃って
// いるのにテストが 1 つも無かった。findAllByTenant は /audit 画面 (Pro/Enterprise 限定) が直接
// 依存するテナントスコープの集計であり、クロステナント漏洩防止・並び順・件数上限のクランプが
// 未検証だった (settings-audit-log-repository と同じ観点)。

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const USER_A = 'user-a';

let store: Store;
let repos: Repos;

// 指定テナントにチケットを 1 件用意する
async function seedTicket(tenantId: string, creatorId: string, title: string) {
  const now = new Date();
  if (!store.users.has(creatorId)) {
    store.users.set(creatorId, {
      id: creatorId,
      email: `${creatorId}@example.com`,
      name: creatorId,
      passwordHash: 'x',
      role: 'agent',
      tenantId,
      createdAt: now,
      updatedAt: now,
    });
  }
  return repos.tickets.create({
    title,
    body: '本文',
    priority: 'Medium',
    creatorId,
    categoryId: null,
    locationId: null,
    tenantId,
  });
}

beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
});

describe('TicketHistoryRepository (memory)', () => {
  // record: 履歴を 1 件記録できる
  it('履歴を1件記録できる', async () => {
    const ticket = await seedTicket(TENANT_A, USER_A, 'チケット');
    await repos.history.record({
      ticketId: ticket.id,
      changedById: USER_A,
      field: 'status',
      oldValue: 'New',
      newValue: 'Open',
    });
    const rows = await repos.history.findAllByTenant({ tenantId: TENANT_A });
    expect(rows).toHaveLength(1);
    expect(rows[0].field).toBe('status');
    expect(rows[0].oldValue).toBe('New');
    expect(rows[0].newValue).toBe('Open');
  });

  // findAllByTenant: 親チケット経由でテナントスコープを判定し、他テナントの履歴は含まない
  // (クロステナント漏洩防止。TicketHistory 自体は tenantId を持たない設計のため要検証)
  it('findAllByTenantは他テナントの履歴を含まない', async () => {
    const ticketA = await seedTicket(TENANT_A, USER_A, 'テナントAのチケット');
    await repos.history.record({
      ticketId: ticketA.id,
      changedById: USER_A,
      field: 'priority',
      oldValue: 'Medium',
      newValue: 'High',
    });
    const userB = 'user-b';
    const ticketB = await seedTicket(TENANT_B, userB, 'テナントBのチケット');
    await repos.history.record({
      ticketId: ticketB.id,
      changedById: userB,
      field: 'priority',
      oldValue: 'Low',
      newValue: 'Medium',
    });

    const rowsA = await repos.history.findAllByTenant({ tenantId: TENANT_A });
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].ticketTitle).toBe('テナントAのチケット');
  });

  // findAllByTenant: 新しい順に並べる
  it('findAllByTenantは新しい順に並べる', async () => {
    const ticket = await seedTicket(TENANT_A, USER_A, 'チケット');
    await repos.history.record({
      ticketId: ticket.id,
      changedById: USER_A,
      field: 'status',
      oldValue: 'New',
      newValue: 'Open',
    });
    await new Promise((r) => setTimeout(r, 2));
    await repos.history.record({
      ticketId: ticket.id,
      changedById: USER_A,
      field: 'status',
      oldValue: 'Open',
      newValue: 'InProgress',
    });
    const rows = await repos.history.findAllByTenant({ tenantId: TENANT_A });
    expect(rows.map((r) => r.newValue)).toEqual(['InProgress', 'Open']);
  });

  // findAllByTenant: 変更者が存在しない (削除済み等) 場合は「不明」で代替する
  it('変更者が見つからない場合は「不明」で代替する', async () => {
    const ticket = await seedTicket(TENANT_A, USER_A, 'チケット');
    await repos.history.record({
      ticketId: ticket.id,
      changedById: 'deleted-user',
      field: 'assignee',
      oldValue: null,
      newValue: USER_A,
    });
    const rows = await repos.history.findAllByTenant({ tenantId: TENANT_A });
    expect(rows[0].changedByName).toBe('不明');
  });

  // §4.2.1 フォローアップ (2026-07-10): before カーソルより後 (同時刻含む) の履歴は除外され、
  // 監査ページの「さらに読み込む」キーセットページネーションが正しく古い履歴へ辿れることを確認する。
  // record() は内部で new Date() を使い時刻を差し替えられないため、ストアへ直接行を投入して
  // createdAt / id を完全に制御する
  it('beforeを指定するとその日時より前の履歴だけに絞り込める', async () => {
    const ticket = await seedTicket(TENANT_A, USER_A, 'チケット');
    const older = new Date('2026-01-01T00:00:00.000Z');
    const newer = new Date('2026-01-01T00:00:01.000Z');
    store.histories.set('hst_older', {
      id: 'hst_older',
      ticketId: ticket.id,
      changedById: USER_A,
      field: 'status',
      oldValue: 'New',
      newValue: 'Open',
      createdAt: older,
    });
    store.histories.set('hst_newer', {
      id: 'hst_newer',
      ticketId: ticket.id,
      changedById: USER_A,
      field: 'status',
      oldValue: 'Open',
      newValue: 'InProgress',
      createdAt: newer,
    });

    // カーソルを新しい行と古い行のちょうど中間に置く
    const cursor = {
      createdAt: new Date('2026-01-01T00:00:00.500Z'),
      kind: 'ticket' as const,
      id: 'irrelevant',
    };
    const rows = await repos.history.findAllByTenant({ tenantId: TENANT_A, before: cursor });
    expect(rows).toHaveLength(1);
    expect(rows[0].newValue).toBe('Open');
  });

  // /code-review ultra 指摘対応 (2026-07-10, §4.2.1 フォローアップ再訪): createdAt が完全に
  // 同一の複数行があっても、id をタイブレーカーにしてページ境界で行を取りこぼさないことを検証する
  it('createdAtが同一の行はidで安定した順序に並び、カーソルで取りこぼさない', async () => {
    const ticket = await seedTicket(TENANT_A, USER_A, 'チケット');
    const sameInstant = new Date('2026-01-01T00:00:00.000Z');
    // 同一 createdAt を持つ 3 行を id 順不同で投入する
    store.histories.set('hst_b', {
      id: 'hst_b',
      ticketId: ticket.id,
      changedById: USER_A,
      field: 'status',
      oldValue: 'New',
      newValue: 'Open',
      createdAt: sameInstant,
    });
    store.histories.set('hst_a', {
      id: 'hst_a',
      ticketId: ticket.id,
      changedById: USER_A,
      field: 'priority',
      oldValue: 'Low',
      newValue: 'Medium',
      createdAt: sameInstant,
    });
    store.histories.set('hst_c', {
      id: 'hst_c',
      ticketId: ticket.id,
      changedById: USER_A,
      field: 'assignee',
      oldValue: null,
      newValue: USER_A,
      createdAt: sameInstant,
    });

    // 1 ページ目: id 降順で 2 件だけ取得する (hst_c, hst_b が先頭 2 件になるはず)
    const page1 = await repos.history.findAllByTenant({ tenantId: TENANT_A, limit: 2 });
    expect(page1.map((r) => r.id)).toEqual(['hst_c', 'hst_b']);

    // 2 ページ目: 1 ページ目の最後の行 (hst_b) をカーソルにすると、残りの hst_a だけが返る
    // (createdAt 単独のカーソルだと同一ミリ秒の行が全て除外されて 0 件になってしまう回帰を防ぐ)
    const page2 = await repos.history.findAllByTenant({
      tenantId: TENANT_A,
      before: { createdAt: sameInstant, kind: 'ticket', id: 'hst_b' },
    });
    expect(page2.map((r) => r.id)).toEqual(['hst_a']);
  });

  // findAllByTenant: limit で件数を絞り込める (§8 一覧取得は必ず上限を持たせる)
  it('limitで件数を絞り込める', async () => {
    const ticket = await seedTicket(TENANT_A, USER_A, 'チケット');
    for (let i = 0; i < 3; i++) {
      await repos.history.record({
        ticketId: ticket.id,
        changedById: USER_A,
        field: 'status',
        oldValue: null,
        newValue: String(i),
      });
    }
    const rows = await repos.history.findAllByTenant({ tenantId: TENANT_A, limit: 2 });
    expect(rows).toHaveLength(2);
  });
});
