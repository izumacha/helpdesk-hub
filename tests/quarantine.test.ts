// recordQuarantineSafe (src/lib/quarantine.ts) の仕様確認テスト。
// フォローアップ (2026-07-21): 監査で発見したギャップ。隔離記録は永続化・admin 向け一覧画面
// (§3.2) まで実装済みだが、隔離が発生したこと自体を admin に知らせるアプリ内通知が無かった。
// 本テストは追加した「admin へ通知 + テナントあたり一定間隔で 1 回だけ」のロジックを検証する。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';

const TENANT = 'tenant-1';
const ADMIN_ID = 'u-admin-1';
const AGENT_ID = 'u-agent-1';

let store: Store;
let repos: Repos;

// @/data を差し替え (getter で beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// next/cache の副作用 (revalidateTag) はテストでは不要
vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
}));

// SSE ブロードキャスト経路もテストでは不要 (購読者がいないだけだが明示的に無効化)
vi.mock('@/lib/sse-subscribers', () => ({
  broadcast: vi.fn(),
}));

beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'テナント',
    mode: 'lite',
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    subscriptionPlan: 'free',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    createdAt: new Date(),
  });
  store.users.set(ADMIN_ID, {
    id: ADMIN_ID,
    email: 'admin@example.com',
    name: '管理者',
    passwordHash: 'x',
    role: 'admin',
    tenantId: TENANT,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  store.users.set(AGENT_ID, {
    id: AGENT_ID,
    email: 'agent@example.com',
    name: '担当者',
    passwordHash: 'x',
    role: 'agent',
    tenantId: TENANT,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

describe('recordQuarantineSafe', () => {
  // 正常系: 隔離記録が保存され、admin へ 'quarantined' 通知が作成される (agent には届かない)
  it('隔離記録の保存後にadminへ通知が作成される', async () => {
    const { recordQuarantineSafe } = await import('@/lib/quarantine');
    await recordQuarantineSafe(
      {
        tenantId: TENANT,
        channel: 'email',
        reason: 'unknown_sender',
        senderAddress: 'x@example.com',
        senderName: null,
        subject: '件名',
      },
      '[test]',
    );
    const records = await repos.quarantinedEmails.findAllByTenant({ tenantId: TENANT });
    expect(records).toHaveLength(1);

    const notifications = [...store.notifications.values()];
    expect(notifications.some((n) => n.userId === ADMIN_ID && n.type === 'quarantined')).toBe(true);
    expect(notifications.some((n) => n.userId === AGENT_ID)).toBe(false);
  });

  // スロットリング: 短時間に複数回隔離が発生しても通知は 1 回だけ (24時間に1回)
  it('短時間の連続隔離では2回目以降は通知しない', async () => {
    const { recordQuarantineSafe } = await import('@/lib/quarantine');
    for (let i = 0; i < 3; i++) {
      await recordQuarantineSafe(
        {
          tenantId: TENANT,
          channel: 'email',
          reason: 'unknown_sender',
          senderAddress: 'x@example.com',
          senderName: null,
          subject: `件名${i}`,
        },
        '[test]',
      );
    }
    const records = await repos.quarantinedEmails.findAllByTenant({ tenantId: TENANT });
    expect(records).toHaveLength(3); // 記録自体は毎回残る

    const notifications = [...store.notifications.values()].filter((n) => n.type === 'quarantined');
    expect(notifications).toHaveLength(1); // 通知は 1 回だけ
  });

  // 24時間以上経過していれば再度通知する
  it('通知間隔を空ければ再度通知される', async () => {
    const { recordQuarantineSafe } = await import('@/lib/quarantine');
    await recordQuarantineSafe(
      {
        tenantId: TENANT,
        channel: 'email',
        reason: 'unknown_sender',
        senderAddress: 'x@example.com',
        senderName: null,
        subject: '件名1',
      },
      '[test]',
    );
    // 直近通知時刻を 25 時間前に巻き戻して間隔経過をシミュレートする
    const tenant = await repos.tenants.findById(TENANT);
    if (!tenant) throw new Error('seed missing tenant');
    store.tenants.set(TENANT, {
      ...tenant,
      quarantineNotifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    await recordQuarantineSafe(
      {
        tenantId: TENANT,
        channel: 'email',
        reason: 'unknown_sender',
        senderAddress: 'x@example.com',
        senderName: null,
        subject: '件名2',
      },
      '[test]',
    );

    const notifications = [...store.notifications.values()].filter((n) => n.type === 'quarantined');
    expect(notifications).toHaveLength(2);
  });

  // 記録自体が失敗した場合は通知も送らない (存在しない隔離を「確認してください」と案内しない)
  it('記録が失敗した場合は通知しない', async () => {
    vi.spyOn(repos.quarantinedEmails, 'record').mockRejectedValueOnce(new Error('DB down'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { recordQuarantineSafe } = await import('@/lib/quarantine');

    await expect(
      recordQuarantineSafe(
        {
          tenantId: TENANT,
          channel: 'email',
          reason: 'unknown_sender',
          senderAddress: 'x@example.com',
          senderName: null,
          subject: '件名',
        },
        '[test]',
      ),
    ).resolves.toBeUndefined();

    const notifications = [...store.notifications.values()].filter((n) => n.type === 'quarantined');
    expect(notifications).toHaveLength(0);
    consoleErrorSpy.mockRestore();
  });

  // 異常系: 通知の送信が失敗しても throw せず、記録自体は成功として扱われる
  it('通知の送信が失敗してもthrowしない', async () => {
    vi.spyOn(repos.users, 'listAdminEmails').mockRejectedValueOnce(new Error('DB down'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { recordQuarantineSafe } = await import('@/lib/quarantine');

    await expect(
      recordQuarantineSafe(
        {
          tenantId: TENANT,
          channel: 'email',
          reason: 'unknown_sender',
          senderAddress: 'x@example.com',
          senderName: null,
          subject: '件名',
        },
        '[test]',
      ),
    ).resolves.toBeUndefined();

    const records = await repos.quarantinedEmails.findAllByTenant({ tenantId: TENANT });
    expect(records).toHaveLength(1); // 記録自体は成功している
    consoleErrorSpy.mockRestore();
  });

  // フォローアップ (2026-07-21): 通知送信の失敗でクレーム (quarantineNotifiedAt) だけが
  // 消費され、以後 24 時間誰にも通知が届かなくなる回帰を防ぐテスト。1 回目は送信失敗
  // (クレームは解除される想定) させ、直後の 2 回目 (間隔を空けない) で通知できることを確認する
  it('通知の送信が失敗した場合はクレームを解除し、直後の隔離発生でも再度通知を試みる', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(repos.users, 'listAdminEmails').mockRejectedValueOnce(new Error('DB down'));
    const { recordQuarantineSafe } = await import('@/lib/quarantine');

    // 1 回目: 通知送信に失敗する
    await recordQuarantineSafe(
      {
        tenantId: TENANT,
        channel: 'email',
        reason: 'unknown_sender',
        senderAddress: 'x@example.com',
        senderName: null,
        subject: '件名1',
      },
      '[test]',
    );
    // クレームが解除され、次回すぐに再度通知を試みられる状態に戻っていること
    const tenantAfterFailure = await repos.tenants.findById(TENANT);
    expect(tenantAfterFailure?.quarantineNotifiedAt).toBeNull();

    // 2 回目: 間隔を空けずに発生しても (listAdminEmails は正常に戻っている) 通知が作成される
    await recordQuarantineSafe(
      {
        tenantId: TENANT,
        channel: 'email',
        reason: 'unknown_sender',
        senderAddress: 'x@example.com',
        senderName: null,
        subject: '件名2',
      },
      '[test]',
    );

    const notifications = [...store.notifications.values()].filter((n) => n.type === 'quarantined');
    expect(notifications).toHaveLength(1); // 1 回目は失敗、2 回目で初めて成功
    consoleErrorSpy.mockRestore();
  });
});
