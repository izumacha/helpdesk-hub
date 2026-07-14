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
// セッションの権限 (テスト中に書き換えて RBAC シナリオを変える。既定はエージェント)
let sessionRole: 'requester' | 'agent' | 'admin' = 'agent';
// テナントスコープ (テストは単一テナント前提で固定)
const TENANT = 'default-tenant';

// @/data モジュールを差し替え。getter で参照することで、テスト中の上書きを反映
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// 認証は固定セッションを返すモックに置換 (role は sessionRole で可変)
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: 'u-agt-1', role: sessionRole, tenantId: TENANT },
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
  sessionRole = 'agent'; // 既定はエージェント (各テストで必要なら requester に上書きする)
  vi.resetModules();
  __resetRateLimits();
});

// 指定ステータスの FAQ 候補を 1 件作成して ID を返す共通シード
// (updateFaqStatus/updateFaqContent のテストで「対象 FAQ が既にある」前提を作るため)
async function seedFaqWithStatus(status: 'Candidate' | 'Published' | 'Rejected'): Promise<string> {
  const ticketId = await seedTicketWithStatus('Resolved');
  const faq = await repos.faq.create({
    ticketId,
    createdById: 'u-agt-1',
    question: '元の質問',
    answer: '元の回答',
    tenantId: TENANT,
  });
  // 作成直後は Candidate 固定のため、検証したいステータスへ直接書き換える
  if (status !== 'Candidate') {
    await repos.faq.updateStatus(faq.id, status, TENANT);
  }
  return faq.id;
}

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

// updateFaqStatus の状態遷移ガードを検証する
// (フォローアップ 2026-07-14 #6: 公開済み FAQ を取り下げる手段が一つも無かったギャップ対応。
//  Candidate→Published/Rejected は既存挙動、Published→Rejected を新たに許可した)
describe('updateFaqStatus', () => {
  it('Candidateから公開できる', async () => {
    const faqId = await seedFaqWithStatus('Candidate');
    const { updateFaqStatus } = await import('@/features/faq/actions/faq-actions');

    await updateFaqStatus(faqId, 'Published');

    const faq = await repos.faq.findById(faqId, TENANT);
    expect(faq?.status).toBe('Published');
  });

  it('Publishedから却下 (非公開化) できる', async () => {
    const faqId = await seedFaqWithStatus('Published');
    const { updateFaqStatus } = await import('@/features/faq/actions/faq-actions');

    await updateFaqStatus(faqId, 'Rejected');

    const faq = await repos.faq.findById(faqId, TENANT);
    expect(faq?.status).toBe('Rejected');
  });

  it('Rejectedからは状態変更できない', async () => {
    const faqId = await seedFaqWithStatus('Rejected');
    const { updateFaqStatus } = await import('@/features/faq/actions/faq-actions');

    await expect(updateFaqStatus(faqId, 'Published')).rejects.toThrow(
      /候補または公開済みのFAQのみ/,
    );
  });

  it('依頼者は実行できない', async () => {
    const faqId = await seedFaqWithStatus('Candidate');
    sessionRole = 'requester';
    const { updateFaqStatus } = await import('@/features/faq/actions/faq-actions');

    await expect(updateFaqStatus(faqId, 'Published')).rejects.toThrow(
      /エージェントまたは管理者のみ/,
    );
  });
});

// updateFaqContent (質問/回答のその場編集) を検証する
// (フォローアップ 2026-07-14 #6: 公開後に誤りへ気付いても訂正する手段が無かったギャップ対応)
describe('updateFaqContent', () => {
  it('Candidateの質問/回答を編集できる', async () => {
    const faqId = await seedFaqWithStatus('Candidate');
    const { updateFaqContent } = await import('@/features/faq/actions/faq-actions');

    await updateFaqContent(faqId, '新しい質問', '新しい回答');

    const faq = await repos.faq.findById(faqId, TENANT);
    expect(faq?.question).toBe('新しい質問');
    expect(faq?.answer).toBe('新しい回答');
  });

  it('Publishedの質問/回答も編集できる (公開後の訂正)', async () => {
    const faqId = await seedFaqWithStatus('Published');
    const { updateFaqContent } = await import('@/features/faq/actions/faq-actions');

    await updateFaqContent(faqId, '訂正後の質問', '訂正後の回答');

    const faq = await repos.faq.findById(faqId, TENANT);
    expect(faq?.question).toBe('訂正後の質問');
    expect(faq?.answer).toBe('訂正後の回答');
    // ステータス自体は変わらない (編集は状態遷移とは独立)
    expect(faq?.status).toBe('Published');
  });

  it('空の質問はエラーになる', async () => {
    const faqId = await seedFaqWithStatus('Candidate');
    const { updateFaqContent } = await import('@/features/faq/actions/faq-actions');

    await expect(updateFaqContent(faqId, '', '回答')).rejects.toThrow(/質問を入力してください/);
  });

  it('依頼者は実行できない', async () => {
    const faqId = await seedFaqWithStatus('Candidate');
    sessionRole = 'requester';
    const { updateFaqContent } = await import('@/features/faq/actions/faq-actions');

    await expect(updateFaqContent(faqId, '新しい質問', '新しい回答')).rejects.toThrow(
      /エージェントまたは管理者のみ/,
    );
  });

  it('他テナントのIDに対してはエラーになる (findByIdでnullになりnot-foundを返す)', async () => {
    const faqId = await seedFaqWithStatus('Candidate');
    const { updateFaqContent } = await import('@/features/faq/actions/faq-actions');
    // 別テナントを装うため findById が null を返す状況を、存在しない ID で代用して検証する
    await expect(updateFaqContent('does-not-exist', '質問', '回答')).rejects.toThrow(
      /見つかりません/,
    );
    // 元の FAQ は変更されていないこと
    const faq = await repos.faq.findById(faqId, TENANT);
    expect(faq?.question).toBe('元の質問');
  });
});
