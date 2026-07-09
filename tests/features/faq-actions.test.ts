// Vitest のテスト DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos を持つ)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束の型
import type { Repos } from '@/data/ports/unit-of-work';
// レート制限の履歴をテスト間でクリアする内部用関数
import { __resetRateLimits } from '@/lib/rate-limit';

// 各テスト前に書き換える "可変" な依存。Action import 前に値を入れる必要がある。
let store: Store;
let repos: Repos;
// テナントスコープ (テストは単一テナント前提で固定)
const TENANT = 'default-tenant';

// @/data モジュールを差し替え。getter で参照することで、テスト中の上書きを反映
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// 認証は固定セッション (エージェント) を返すモックに置換
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: 'u-agt-1', role: 'agent', tenantId: TENANT },
  }),
}));

// next/cache の副作用は不要なので spy で潰す
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// テナント mode を差し替えるヘルパー (seed 後に呼ぶ)
function setTenantMode(mode: 'lite' | 'pro') {
  const t = store.tenants.get(TENANT);
  if (!t) throw new Error('seed missing default-tenant');
  store.tenants.set(TENANT, { ...t, mode });
}

// 指定ステータスのチケットを 1 件作成して ID を返す共通シード
async function seedTicketWithStatus(status: string): Promise<string> {
  const now = new Date();
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode: 'pro',
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    subscriptionPlan: 'free' as const,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    createdAt: now,
  });
  store.users.set('u-req-1', {
    id: 'u-req-1',
    email: 'u-req-1@example.com',
    name: '山田',
    passwordHash: 'x',
    role: 'requester',
    tenantId: TENANT,
    createdAt: now,
    updatedAt: now,
  });
  store.users.set('u-agt-1', {
    id: 'u-agt-1',
    email: 'u-agt-1@example.com',
    name: '佐藤',
    passwordHash: 'x',
    role: 'agent',
    tenantId: TENANT,
    createdAt: now,
    updatedAt: now,
  });
  const ticket = await repos.tickets.create({
    title: 'VPN がつながらない',
    body: '朝から繋がらないです',
    priority: 'Medium',
    creatorId: 'u-req-1',
    categoryId: null,
    tenantId: TENANT,
  });
  // 生成直後は New のため、検証したいステータスへ直接書き換える (状態遷移ガードを経由せず、
  // FAQ 化の可否判定だけを単体で検証したいため updateStatus を直接呼ぶ)
  await repos.tickets.updateStatus(ticket.id, status as never, null, TENANT);
  return ticket.id;
}

// 各テスト前に依存とレート制限をリセット (テスト間の独立性を確保)
beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  vi.resetModules();
  __resetRateLimits();
});

// createFaqCandidate の mode-aware な完了判定を検証する
// (§1.1 フォローアップ: 以前は Resolved 固定だったため、Lite テナントのチケットは
//  Lite 遷移表上 Resolved に到達できず FAQ 候補化が常に失敗していた)
describe('createFaqCandidate', () => {
  it('Pro モードでは Resolved のチケットを FAQ 候補化できる', async () => {
    const ticketId = await seedTicketWithStatus('Resolved');
    setTenantMode('pro');
    const { createFaqCandidate } = await import('@/features/faq/actions/faq-actions');

    await createFaqCandidate(ticketId, '質問', '回答');

    const faqs = await repos.faq.list(TENANT);
    expect(faqs).toHaveLength(1);
  });

  it('Pro モードでは Closed のチケットは FAQ 候補化できない', async () => {
    const ticketId = await seedTicketWithStatus('Closed');
    setTenantMode('pro');
    const { createFaqCandidate } = await import('@/features/faq/actions/faq-actions');

    await expect(createFaqCandidate(ticketId, '質問', '回答')).rejects.toThrow(
      /完了済みチケットのみ/,
    );
  });

  it('Lite モードでは Closed (Lite の「完了」) のチケットを FAQ 候補化できる', async () => {
    const ticketId = await seedTicketWithStatus('Closed');
    setTenantMode('lite');
    const { createFaqCandidate } = await import('@/features/faq/actions/faq-actions');

    await createFaqCandidate(ticketId, '質問', '回答');

    const faqs = await repos.faq.list(TENANT);
    expect(faqs).toHaveLength(1);
  });

  it('Lite モードでも旧 Pro データの Resolved は FAQ 候補化できる (後方互換)', async () => {
    const ticketId = await seedTicketWithStatus('Resolved');
    setTenantMode('lite');
    const { createFaqCandidate } = await import('@/features/faq/actions/faq-actions');

    await createFaqCandidate(ticketId, '質問', '回答');

    const faqs = await repos.faq.list(TENANT);
    expect(faqs).toHaveLength(1);
  });

  it('Lite モードでは未対応 (Open) のチケットは FAQ 候補化できない', async () => {
    const ticketId = await seedTicketWithStatus('Open');
    setTenantMode('lite');
    const { createFaqCandidate } = await import('@/features/faq/actions/faq-actions');

    await expect(createFaqCandidate(ticketId, '質問', '回答')).rejects.toThrow(
      /完了済みチケットのみ/,
    );
  });
});
