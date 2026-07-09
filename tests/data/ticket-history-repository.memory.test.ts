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
