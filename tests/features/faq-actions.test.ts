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
    await repos.faq.updateStatus(faq.id, { from: 'Candidate', to: status }, TENANT);
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

    // 「画面の表示が古い」ケースがほとんどのため、最新表示の確認を促す文言を返す
    // (呼称は mode-aware。シードは pro のため「FAQ候補」。§6 ラベル一元管理)
    await expect(updateFaqStatus(faqId, 'Published')).rejects.toThrow(
      /現在の状態では実行できない操作です。最新のFAQ候補をご確認ください/,
    );
  });

  // フォローアップ (2026-07-15): check-then-act 競合の防止。読み取り時 (findById) と
  // 書き込み時の間に別の操作が状態を変えていた場合、無条件更新だと遷移表が禁止する
  // Rejected→Published が後勝ちで成立してしまう。条件付き更新で拒否されることを検証する
  it('読み取り後に状態が変わっていた場合は競合エラーになり禁止遷移が成立しない', async () => {
    // 実際の行は既に Rejected (先行操作が却下済み)
    const faqId = await seedFaqWithStatus('Rejected');
    const current = await repos.faq.findById(faqId, TENANT);
    if (!current) throw new Error('seed missing faq');
    // findById だけが古いスナップショット (Candidate) を返す状況を作る (TOCTOU の再現)
    vi.spyOn(repos.faq, 'findById').mockResolvedValueOnce({ ...current, status: 'Candidate' });
    const { updateFaqStatus } = await import('@/features/faq/actions/faq-actions');

    // 遷移ガード (Candidate→Published) は通過するが、条件付き更新が競合を検出して失敗する
    await expect(updateFaqStatus(faqId, 'Published')).rejects.toThrow(/他の操作と競合したため/);

    // 状態は Rejected のまま (禁止遷移 Rejected→Published が成立していない)
    const reloaded = await repos.faq.findById(faqId, TENANT);
    expect(reloaded?.status).toBe('Rejected');
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

  it('他テナントのIDに対してはエラーになり、その内容も書き換わらない', async () => {
    // セッションのテナント (TENANT) とは別テナントに FAQ を作成する
    const OTHER_TENANT = 'other-tenant';
    const now = new Date();
    store.users.set('u-other-agt', {
      id: 'u-other-agt',
      email: 'u-other-agt@example.com',
      name: '別テナントの担当者',
      passwordHash: 'x',
      role: 'agent',
      tenantId: OTHER_TENANT,
      createdAt: now,
      updatedAt: now,
    });
    const otherTicket = await repos.tickets.create({
      title: '別テナントのチケット',
      body: '本文',
      priority: 'Medium',
      creatorId: 'u-other-agt',
      categoryId: null,
      locationId: null,
      tenantId: OTHER_TENANT,
    });
    const otherFaq = await repos.faq.create({
      ticketId: otherTicket.id,
      createdById: 'u-other-agt',
      question: '他テナントの質問',
      answer: '他テナントの回答',
      tenantId: OTHER_TENANT,
    });

    const { updateFaqContent } = await import('@/features/faq/actions/faq-actions');
    // 自テナント (TENANT) のセッションから他テナントの FAQ ID を指定すると見つからない扱いになる
    await expect(updateFaqContent(otherFaq.id, '書き換え試行', '書き換え試行')).rejects.toThrow(
      /見つかりません/,
    );
    // 他テナントの FAQ は変更されていないこと (クロステナント書き換えが起きていない)
    const reloaded = await repos.faq.findById(otherFaq.id, OTHER_TENANT);
    expect(reloaded?.question).toBe('他テナントの質問');
    expect(reloaded?.answer).toBe('他テナントの回答');
  });
});
