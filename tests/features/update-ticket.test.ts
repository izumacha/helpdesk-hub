import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
import { __resetRateLimits } from '@/lib/rate-limit';

// Holders populated per-test before importing the Action under test.
let store: Store;
let repos: Repos;
let uow: UnitOfWork;
let sessionUserId = 'u-agt-1';
let sessionRole: 'requester' | 'agent' | 'admin' = 'agent';

vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
  get uow() {
    return uow;
  },
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: sessionUserId, role: sessionRole } }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock('@/lib/sse-subscribers', () => ({
  broadcast: vi.fn(),
}));

async function seed() {
  const now = new Date();
  const users = [
    { id: 'u-req-1', role: 'requester' as const, name: '山田' },
    { id: 'u-agt-1', role: 'agent' as const, name: '佐藤' },
    { id: 'u-agt-2', role: 'agent' as const, name: '鈴木' },
  ];
  for (const u of users) {
    store.users.set(u.id, {
      id: u.id,
      email: `${u.id}@example.com`,
      name: u.name,
      passwordHash: 'x',
      role: u.role,
      createdAt: now,
      updatedAt: now,
    });
  }
  store.categories.set('cat-1', { id: 'cat-1', name: 'アカウント', createdAt: now });
  const ticket = await repos.tickets.create({
    title: 'VPN がつながらない',
    body: '朝から繋がらないです',
    priority: 'Medium',
    creatorId: 'u-req-1',
    categoryId: 'cat-1',
  });
  return { ticketId: ticket.id };
}

beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  uow = ctx.uow;
  sessionUserId = 'u-agt-1';
  sessionRole = 'agent';
  vi.resetModules();
  __resetRateLimits();
});

describe('updateTicketStatus (provider-agnostic)', () => {
  it('applies a valid transition and records history', async () => {
    const { ticketId } = await seed();
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketStatus(ticketId, 'Open');

    const t = await repos.tickets.findById(ticketId);
    expect(t?.status).toBe('Open');
    const histories = [...store.histories.values()].filter((h) => h.ticketId === ticketId);
    expect(histories).toHaveLength(1);
    expect(histories[0].field).toBe('status');
    expect(histories[0].oldValue).toBe('New');
    expect(histories[0].newValue).toBe('Open');
  });

  it('rejects an invalid transition and rolls back history', async () => {
    const { ticketId } = await seed();
    await repos.tickets.updateStatus(ticketId, 'Closed', null);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    await expect(updateTicketStatus(ticketId, 'InProgress')).rejects.toThrow(
      /変更することはできません/,
    );

    const t = await repos.tickets.findById(ticketId);
    expect(t?.status).toBe('Closed');
    expect([...store.histories.values()]).toHaveLength(0);
  });

  it('refuses when caller is not an agent', async () => {
    const { ticketId } = await seed();
    sessionUserId = 'u-req-1';
    sessionRole = 'requester';
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    await expect(updateTicketStatus(ticketId, 'Open')).rejects.toThrow(/エージェントまたは管理者/);
  });

  it('sets resolvedAt when transitioning to Resolved', async () => {
    const { ticketId } = await seed();
    await repos.tickets.updateStatus(ticketId, 'Open', null);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    const before = Date.now();
    await updateTicketStatus(ticketId, 'Resolved');
    const after = Date.now();

    const t = await repos.tickets.findById(ticketId);
    expect(t?.status).toBe('Resolved');
    expect(t?.resolvedAt).toBeInstanceOf(Date);
    const ts = t!.resolvedAt!.getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('clears resolvedAt when reopening from Resolved', async () => {
    const { ticketId } = await seed();
    await repos.tickets.updateStatus(ticketId, 'Resolved', new Date());
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketStatus(ticketId, 'Open');

    const t = await repos.tickets.findById(ticketId);
    expect(t?.status).toBe('Open');
    expect(t?.resolvedAt).toBeNull();
  });

  it('leaves resolvedAt untouched for transitions not involving Resolved', async () => {
    const { ticketId } = await seed();
    await repos.tickets.updateStatus(ticketId, 'Open', null);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketStatus(ticketId, 'InProgress');

    const t = await repos.tickets.findById(ticketId);
    expect(t?.status).toBe('InProgress');
    expect(t?.resolvedAt).toBeNull();
  });
});

describe('updateTicketAssignee (provider-agnostic)', () => {
  it('assigns an agent, records history, creates a notification', async () => {
    const { ticketId } = await seed();
    const { updateTicketAssignee } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketAssignee(ticketId, 'u-agt-2');

    const t = await repos.tickets.findById(ticketId);
    expect(t?.assigneeId).toBe('u-agt-2');

    const histories = [...store.histories.values()];
    expect(histories).toHaveLength(1);
    expect(histories[0].field).toBe('assignee');
    expect(histories[0].newValue).toBe('鈴木');

    const notifications = [...store.notifications.values()];
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe('u-agt-2');
    expect(notifications[0].type).toBe('assigned');
  });

  it('refuses to assign a requester', async () => {
    const { ticketId } = await seed();
    const { updateTicketAssignee } = await import('@/features/tickets/actions/update-ticket');

    await expect(updateTicketAssignee(ticketId, 'u-req-1')).rejects.toThrow(
      /指定された担当者を設定できません/,
    );
    expect([...store.histories.values()]).toHaveLength(0);
    expect([...store.notifications.values()]).toHaveLength(0);
  });

  it('refuses to assign a non-existent user with the same message', async () => {
    const { ticketId } = await seed();
    const { updateTicketAssignee } = await import('@/features/tickets/actions/update-ticket');

    await expect(updateTicketAssignee(ticketId, 'u-missing')).rejects.toThrow(
      /指定された担当者を設定できません/,
    );
    expect([...store.histories.values()]).toHaveLength(0);
    expect([...store.notifications.values()]).toHaveLength(0);
  });
});

describe('addComment (provider-agnostic)', () => {
  it('notifies the assignee when a requester comments on an assigned ticket', async () => {
    const { ticketId } = await seed();
    await repos.tickets.updateAssignee(ticketId, 'u-agt-2');
    sessionUserId = 'u-req-1';
    sessionRole = 'requester';
    const { addComment } = await import('@/features/tickets/actions/update-ticket');

    await addComment(ticketId, '追加情報です');

    const comments = [...store.comments.values()].filter((c) => c.ticketId === ticketId);
    expect(comments).toHaveLength(1);
    expect(comments[0].authorId).toBe('u-req-1');

    const notifications = [...store.notifications.values()];
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe('u-agt-2');
    expect(notifications[0].type).toBe('commented');
    expect(notifications[0].ticketId).toBe(ticketId);
  });

  it('notifies every agent when a requester comments on an unassigned ticket', async () => {
    const { ticketId } = await seed();
    sessionUserId = 'u-req-1';
    sessionRole = 'requester';
    const { addComment } = await import('@/features/tickets/actions/update-ticket');

    await addComment(ticketId, 'どうなってますか');

    const notifications = [...store.notifications.values()];
    expect(new Set(notifications.map((n) => n.userId))).toEqual(new Set(['u-agt-1', 'u-agt-2']));
    for (const n of notifications) {
      expect(n.type).toBe('commented');
      expect(n.ticketId).toBe(ticketId);
    }
  });

  it('notifies the ticket creator when an agent comments', async () => {
    const { ticketId } = await seed();
    const { addComment } = await import('@/features/tickets/actions/update-ticket');

    await addComment(ticketId, '確認しました');

    const notifications = [...store.notifications.values()];
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe('u-req-1');
    expect(notifications[0].type).toBe('commented');
  });

  it('notifies both creator and assignee when a different agent comments', async () => {
    const { ticketId } = await seed();
    await repos.tickets.updateAssignee(ticketId, 'u-agt-2');
    const { addComment } = await import('@/features/tickets/actions/update-ticket');

    await addComment(ticketId, '対応を引き継ぎます');

    const notifications = [...store.notifications.values()];
    expect(new Set(notifications.map((n) => n.userId))).toEqual(new Set(['u-req-1', 'u-agt-2']));
    for (const n of notifications) {
      expect(n.type).toBe('commented');
    }
  });

  it('does not notify the commenter themselves', async () => {
    const { ticketId } = await seed();
    await repos.tickets.updateAssignee(ticketId, 'u-agt-1');
    // assignee and commenter are both u-agt-1
    const { addComment } = await import('@/features/tickets/actions/update-ticket');

    await addComment(ticketId, '自分のコメント');

    const notifications = [...store.notifications.values()];
    expect(notifications.map((n) => n.userId)).toEqual(['u-req-1']);
  });

  it('refuses to comment from a requester who is not the creator', async () => {
    const { ticketId } = await seed();
    sessionUserId = 'u-req-2';
    sessionRole = 'requester';
    // seed a second requester
    const now = new Date();
    store.users.set('u-req-2', {
      id: 'u-req-2',
      email: 'u-req-2@example.com',
      name: '田中',
      passwordHash: 'x',
      role: 'requester',
      createdAt: now,
      updatedAt: now,
    });
    const { addComment } = await import('@/features/tickets/actions/update-ticket');

    await expect(addComment(ticketId, 'よそからのコメント')).rejects.toThrow(/コメント権限/);
    expect([...store.comments.values()]).toHaveLength(0);
    expect([...store.notifications.values()]).toHaveLength(0);
  });
});

describe('escalateTicket (provider-agnostic)', () => {
  it('marks escalated, records history, and notifies every agent', async () => {
    const { ticketId } = await seed();
    await repos.tickets.updateStatus(ticketId, 'Open', null);
    const { escalateTicket } = await import('@/features/tickets/actions/update-ticket');

    await escalateTicket(ticketId, '  対応困難  ');

    const t = await repos.tickets.findById(ticketId);
    expect(t?.status).toBe('Escalated');
    expect(t?.escalationReason).toBe('対応困難');
    expect(t?.escalatedAt).toBeInstanceOf(Date);

    const notifications = [...store.notifications.values()];
    expect(notifications).toHaveLength(2);
    expect(new Set(notifications.map((n) => n.userId))).toEqual(new Set(['u-agt-1', 'u-agt-2']));
    for (const n of notifications) {
      expect(n.type).toBe('escalated');
      expect(n.ticketId).toBe(ticketId);
    }
  });
});
