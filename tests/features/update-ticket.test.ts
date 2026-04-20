// Vitest のテスト DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos/uow を持つ)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束 / UoW の型
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
// レート制限の履歴をテスト間でクリアする内部用関数
import { __resetRateLimits } from '@/lib/rate-limit';

// 各テスト前に書き換える "可変" な依存。Action import 前に値を入れる必要がある。
let store: Store;
let repos: Repos;
let uow: UnitOfWork;
// セッションのユーザー ID と権限 (テスト中に書き換えてシナリオを変える)
let sessionUserId = 'u-agt-1';
let sessionRole: 'requester' | 'agent' | 'admin' = 'agent';

// @/data モジュールを差し替え。getter で参照することで、テスト中の上書きを反映
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
  get uow() {
    return uow;
  },
}));

// 認証は固定セッションを返すモックに置換
vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: sessionUserId, role: sessionRole } }),
}));

// next/cache の副作用は不要なので spy で潰す
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

// SSE ブロードキャストもテストでは不要
vi.mock('@/lib/sse-subscribers', () => ({
  broadcast: vi.fn(),
}));

// 共通シード: 1 依頼者 + 2 エージェント + 1 カテゴリ + 1 チケット
async function seed() {
  const now = new Date();
  // ユーザー雛形
  const users = [
    { id: 'u-req-1', role: 'requester' as const, name: '山田' },
    { id: 'u-agt-1', role: 'agent' as const, name: '佐藤' },
    { id: 'u-agt-2', role: 'agent' as const, name: '鈴木' },
  ];
  // store に直接ユーザーを投入
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
  // カテゴリも 1 件
  store.categories.set('cat-1', { id: 'cat-1', name: 'アカウント', createdAt: now });
  // 検証対象のチケットを依頼者で作成
  const ticket = await repos.tickets.create({
    title: 'VPN がつながらない',
    body: '朝から繋がらないです',
    priority: 'Medium',
    creatorId: 'u-req-1',
    categoryId: 'cat-1',
  });
  return { ticketId: ticket.id };
}

// 各テスト前に依存とレート制限をリセット (テスト間の独立性を確保)
beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  uow = ctx.uow;
  // 既定セッションは agent
  sessionUserId = 'u-agt-1';
  sessionRole = 'agent';
  // 動的 import の結果をリセット (mock 設定を反映させるため)
  vi.resetModules();
  // レート制限の履歴をクリア (前テストの呼び出し回数を引きずらない)
  __resetRateLimits();
});

// ステータス更新アクションの仕様
describe('updateTicketStatus (provider-agnostic)', () => {
  // 正しい遷移なら適用され、履歴も 1 件残ること
  it('applies a valid transition and records history', async () => {
    const { ticketId } = await seed();
    // モックを差し替えてから動的 import (毎回新しいモジュールに)
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketStatus(ticketId, 'Open');

    const t = await repos.tickets.findById(ticketId);
    // 反映されている
    expect(t?.status).toBe('Open');
    // 履歴 1 件 (status / New → Open)
    const histories = [...store.histories.values()].filter((h) => h.ticketId === ticketId);
    expect(histories).toHaveLength(1);
    expect(histories[0].field).toBe('status');
    expect(histories[0].oldValue).toBe('New');
    expect(histories[0].newValue).toBe('Open');
  });

  // 不正な遷移では拒否し、履歴も残らないこと (ロールバック)
  it('rejects an invalid transition and rolls back history', async () => {
    const { ticketId } = await seed();
    // 事前に Closed にしておく
    await repos.tickets.updateStatus(ticketId, 'Closed', null);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    // Closed → InProgress は遷移表で禁止されている
    await expect(updateTicketStatus(ticketId, 'InProgress')).rejects.toThrow(
      /変更することはできません/,
    );

    const t = await repos.tickets.findById(ticketId);
    // ステータスは変わらない
    expect(t?.status).toBe('Closed');
    // 履歴も残っていない
    expect([...store.histories.values()]).toHaveLength(0);
  });

  // エージェントでない呼び出しは権限エラーで拒否
  it('refuses when caller is not an agent', async () => {
    const { ticketId } = await seed();
    // 依頼者セッションに切り替え
    sessionUserId = 'u-req-1';
    sessionRole = 'requester';
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    await expect(updateTicketStatus(ticketId, 'Open')).rejects.toThrow(/エージェントまたは管理者/);
  });

  // Resolved に遷移すると resolvedAt が現在時刻で記録される
  it('sets resolvedAt when transitioning to Resolved', async () => {
    const { ticketId } = await seed();
    // 事前に Open に
    await repos.tickets.updateStatus(ticketId, 'Open', null);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    // 期待時刻範囲を取るため呼び出し前後の時刻を測る
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

  // Resolved → Open に戻すと resolvedAt がクリアされる
  it('clears resolvedAt when reopening from Resolved', async () => {
    const { ticketId } = await seed();
    await repos.tickets.updateStatus(ticketId, 'Resolved', new Date());
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketStatus(ticketId, 'Open');

    const t = await repos.tickets.findById(ticketId);
    expect(t?.status).toBe('Open');
    expect(t?.resolvedAt).toBeNull();
  });

  // Resolved に関係しない遷移では resolvedAt は変化しない
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

// 担当者更新アクションの仕様
describe('updateTicketAssignee (provider-agnostic)', () => {
  // 正常系: 担当者を割り当てると履歴と通知が作られる
  it('assigns an agent, records history, creates a notification', async () => {
    const { ticketId } = await seed();
    const { updateTicketAssignee } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketAssignee(ticketId, 'u-agt-2');

    const t = await repos.tickets.findById(ticketId);
    expect(t?.assigneeId).toBe('u-agt-2');

    // 履歴 1 件 (assignee / null → 鈴木)
    const histories = [...store.histories.values()];
    expect(histories).toHaveLength(1);
    expect(histories[0].field).toBe('assignee');
    expect(histories[0].newValue).toBe('鈴木');

    // 担当者本人にだけ assigned 通知が届く
    const notifications = [...store.notifications.values()];
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe('u-agt-2');
    expect(notifications[0].type).toBe('assigned');
  });

  // 依頼者を担当者にしようとすると拒否される
  it('refuses to assign a requester', async () => {
    const { ticketId } = await seed();
    const { updateTicketAssignee } = await import('@/features/tickets/actions/update-ticket');

    await expect(updateTicketAssignee(ticketId, 'u-req-1')).rejects.toThrow(
      /指定された担当者を設定できません/,
    );
    expect([...store.histories.values()]).toHaveLength(0);
    expect([...store.notifications.values()]).toHaveLength(0);
  });

  // 存在しないユーザーを指定しても同じメッセージで拒否 (内部理由は漏らさない)
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

// コメント追加アクションの通知ルート (誰に通知が飛ぶか) の仕様
describe('addComment (provider-agnostic)', () => {
  // 依頼者がコメント、担当者ありなら担当者だけに通知
  it('notifies the assignee when a requester comments on an assigned ticket', async () => {
    const { ticketId } = await seed();
    await repos.tickets.updateAssignee(ticketId, 'u-agt-2');
    sessionUserId = 'u-req-1';
    sessionRole = 'requester';
    const { addComment } = await import('@/features/tickets/actions/update-ticket');

    await addComment(ticketId, '追加情報です');

    // コメント本体は依頼者の投稿として 1 件保存
    const comments = [...store.comments.values()].filter((c) => c.ticketId === ticketId);
    expect(comments).toHaveLength(1);
    expect(comments[0].authorId).toBe('u-req-1');

    // 通知は担当者 1 名のみ
    const notifications = [...store.notifications.values()];
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe('u-agt-2');
    expect(notifications[0].type).toBe('commented');
    expect(notifications[0].ticketId).toBe(ticketId);
  });

  // 依頼者がコメント、担当者未定なら全エージェントに通知 (取りこぼし防止)
  it('notifies every agent when a requester comments on an unassigned ticket', async () => {
    const { ticketId } = await seed();
    sessionUserId = 'u-req-1';
    sessionRole = 'requester';
    const { addComment } = await import('@/features/tickets/actions/update-ticket');

    await addComment(ticketId, 'どうなってますか');

    const notifications = [...store.notifications.values()];
    // 全エージェントに同じ種別 / 同じチケット紐づけで通知される
    expect(new Set(notifications.map((n) => n.userId))).toEqual(new Set(['u-agt-1', 'u-agt-2']));
    for (const n of notifications) {
      expect(n.type).toBe('commented');
      expect(n.ticketId).toBe(ticketId);
    }
  });

  // エージェントがコメント、担当者未定なら依頼者にだけ通知
  it('notifies the ticket creator when an agent comments', async () => {
    const { ticketId } = await seed();
    const { addComment } = await import('@/features/tickets/actions/update-ticket');

    await addComment(ticketId, '確認しました');

    const notifications = [...store.notifications.values()];
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe('u-req-1');
    expect(notifications[0].type).toBe('commented');
  });

  // エージェントがコメント、担当者ありなら依頼者と担当者の両方に通知
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

  // 投稿者自身には通知しない (重複通知の防止)
  it('does not notify the commenter themselves', async () => {
    const { ticketId } = await seed();
    await repos.tickets.updateAssignee(ticketId, 'u-agt-1');
    // 担当者と投稿者が同一 (u-agt-1)
    const { addComment } = await import('@/features/tickets/actions/update-ticket');

    await addComment(ticketId, '自分のコメント');

    const notifications = [...store.notifications.values()];
    // 依頼者 1 名にだけ届く (自分 = u-agt-1 は除外)
    expect(notifications.map((n) => n.userId)).toEqual(['u-req-1']);
  });

  // チケット作成者でない依頼者は権限エラーで拒否
  it('refuses to comment from a requester who is not the creator', async () => {
    const { ticketId } = await seed();
    sessionUserId = 'u-req-2';
    sessionRole = 'requester';
    // 別人の依頼者をシード追加
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

// エスカレーションアクションの仕様
describe('escalateTicket (provider-agnostic)', () => {
  // 状態を Escalated にし、履歴を残し、全エージェントに通知が届くこと
  it('marks escalated, records history, and notifies every agent', async () => {
    const { ticketId } = await seed();
    // Open 状態からエスカレーション (遷移表で許可されている)
    await repos.tickets.updateStatus(ticketId, 'Open', null);
    const { escalateTicket } = await import('@/features/tickets/actions/update-ticket');

    // 前後空白を含めて渡し、保存時にトリムされていることも確認
    await escalateTicket(ticketId, '  対応困難  ');

    const t = await repos.tickets.findById(ticketId);
    expect(t?.status).toBe('Escalated');
    expect(t?.escalationReason).toBe('対応困難');
    expect(t?.escalatedAt).toBeInstanceOf(Date);

    // 通知は 2 エージェント全員に届く
    const notifications = [...store.notifications.values()];
    expect(notifications).toHaveLength(2);
    expect(new Set(notifications.map((n) => n.userId))).toEqual(new Set(['u-agt-1', 'u-agt-2']));
    for (const n of notifications) {
      expect(n.type).toBe('escalated');
      expect(n.ticketId).toBe(ticketId);
    }
  });
});
