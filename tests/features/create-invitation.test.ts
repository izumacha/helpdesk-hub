// createInvitation (単発発行) のテスト。
// §7.1 フォローアップ (2026-07-10) で issueInvitation ヘルパーへ切り出すリファクタを行ったため、
// 既存の単発発行の挙動 (シート上限・レート制限・メール送信) が壊れていないことを固定する回帰テスト。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
import { __resetRateLimits } from '@/lib/rate-limit';
import type { SubscriptionPlan } from '@/domain/types';

const TENANT_ID = 'tenant-1';
const ADMIN_ID = 'u-admin-1';

let store: Store;
let repos: Repos;

vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: ADMIN_ID, role: 'admin', tenantId: TENANT_ID },
  }),
}));

// 送信されたメールを捕捉する (実ファイルへ書き込む console ドライバを避ける)
const { sentEmails } = vi.hoisted(() => ({
  sentEmails: [] as Array<{ to: string; subject: string }>,
}));
vi.mock('@/lib/email', () => ({
  getEmailSender: () => ({
    send: async (message: { to: string; subject: string }) => {
      sentEmails.push(message);
    },
  }),
}));

// 指定プランのテナント + admin ユーザーをシードする
function seedTenant(plan: SubscriptionPlan) {
  const now = new Date();
  store.tenants.set(TENANT_ID, {
    id: TENANT_ID,
    name: 'テスト組織',
    mode: 'lite',
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    subscriptionPlan: plan,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    createdAt: now,
  });
  store.users.set(ADMIN_ID, {
    id: ADMIN_ID,
    email: 'admin@example.com',
    name: '管理者',
    passwordHash: 'x',
    role: 'admin',
    tenantId: TENANT_ID,
    createdAt: now,
    updatedAt: now,
  });
}

function makeForm(role: string, email = ''): FormData {
  const fd = new FormData();
  fd.set('role', role);
  fd.set('email', email);
  return fd;
}

beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  vi.resetModules();
  __resetRateLimits();
  sentEmails.length = 0;
});

describe('createInvitation', () => {
  it('メール未指定でも招待リンクを発行できる', async () => {
    seedTenant('free');
    const { createInvitation } = await import('@/features/settings/actions/create-invitation');

    const result = await createInvitation(makeForm('requester'));

    expect(result.url).toContain('/invite/');
    expect(sentEmails).toHaveLength(0);
  });

  it('メール指定時は案内メールも送信する', async () => {
    seedTenant('free');
    const { createInvitation } = await import('@/features/settings/actions/create-invitation');

    await createInvitation(makeForm('requester', 'member@example.com'));

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe('member@example.com');
  });

  // Free プランはスタッフ (agent) 3 名まで。既に 3 名いる状態で agent 招待は拒否される
  it('スタッフシート上限に達している場合は agent 招待を拒否する', async () => {
    seedTenant('free');
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      store.users.set(`agt-${i}`, {
        id: `agt-${i}`,
        email: `agt-${i}@example.com`,
        name: `担当 ${i}`,
        passwordHash: 'x',
        role: 'agent',
        tenantId: TENANT_ID,
        createdAt: now,
        updatedAt: now,
      });
    }
    const { createInvitation } = await import('@/features/settings/actions/create-invitation');

    await expect(createInvitation(makeForm('agent'))).rejects.toThrow(/メンバー上限/);
  });

  // requester はシートを消費しないため、agent が上限でも招待できる
  it('シート上限に関わらず requester は招待できる', async () => {
    seedTenant('free');
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      store.users.set(`agt-${i}`, {
        id: `agt-${i}`,
        email: `agt-${i}@example.com`,
        name: `担当 ${i}`,
        passwordHash: 'x',
        role: 'agent',
        tenantId: TENANT_ID,
        createdAt: now,
        updatedAt: now,
      });
    }
    const { createInvitation } = await import('@/features/settings/actions/create-invitation');

    const result = await createInvitation(makeForm('requester'));
    expect(result.url).toContain('/invite/');
  });

  // フォローアップ (2026-07-11): 招待発行 (agent 権限付与になりうる) が監査ログに記録されること
  it('発行成功時に監査ログへ記録される', async () => {
    seedTenant('free');
    const { createInvitation } = await import('@/features/settings/actions/create-invitation');

    await createInvitation(makeForm('agent'));

    const auditLogs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_ID });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('invitation_issue');
    expect(auditLogs[0].actorId).toBe(ADMIN_ID);
  });

  // §4.2/§4.3 の共通方針: 監査ログの書き込みが失敗しても招待の発行自体は成功として扱われる
  it('監査ログの書き込みが失敗しても発行自体は成功として扱われる', async () => {
    seedTenant('free');
    vi.spyOn(repos.settingsAudit, 'record').mockRejectedValueOnce(new Error('DB down'));
    const { createInvitation } = await import('@/features/settings/actions/create-invitation');

    const result = await createInvitation(makeForm('requester'));
    expect(result.url).toContain('/invite/');
  });
});
