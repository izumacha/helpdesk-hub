// Vitest のテスト DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos/uow)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束 / UnitOfWork の型
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
// レート制限の履歴をテスト間でクリアする内部用関数
import { __resetRateLimits } from '@/lib/rate-limit';

// 各テスト前に書き換える依存。Action import 前に getter で参照させる
let store: Store;
let repos: Repos;
let uow: UnitOfWork;
// セッションの権限 (テスト中に書き換えてシナリオを変える)
let sessionRole: 'requester' | 'agent' | 'admin' = 'admin';

// 呼び出し元テナント (作成される新テナントとは別物であることを確認する)
const CALLER_TENANT = 'caller-tenant';

// @/data を差し替え。getter で参照することで、テスト中の上書きが反映される
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
  get uow() {
    return uow;
  },
}));

// 認証は固定セッションを返すモックに置換 (権限は sessionRole で切替)
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: 'admin-1', role: sessionRole, tenantId: CALLER_TENANT },
  }),
}));

// 動的 import: 上のモック設定が反映された後で対象を読み込む
async function loadAction() {
  const mod = await import('@/features/settings/actions/create-tenant');
  return mod.createTenant;
}

// FormData を組み立てるヘルパー
function makeForm(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

// テストごとにクリーンな状態にする
beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  uow = ctx.uow;
  sessionRole = 'admin';
  // レート制限履歴をクリア (テスト間の干渉を防ぐ)
  __resetRateLimits();
  // 呼び出し元テナントを 1 つ用意しておく
  store.tenants.set(CALLER_TENANT, {
    id: CALLER_TENANT,
    name: '呼び出し元組織',
    mode: 'lite',
    industry: null,
    inboundToken: null, // メール取り込み未発行 (テスト用フィクスチャ)
    slackWebhookUrl: null,
    subscriptionPlan: 'free' as const,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null, // Slack 通知未設定 (テスト用フィクスチャ)
    createdAt: new Date(),
  });
});

describe('createTenant', () => {
  // 新しいテナントと初代管理者 (admin) が作成されること
  it('新しい組織と初代管理者を作成する', async () => {
    const createTenant = await loadAction();
    // テナント + 初代管理者を作成する
    const result = await createTenant(
      makeForm({
        tenantName: '新組織',
        // industry は INDUSTRY_TEMPLATES の ID を指定する (UI の <select> の value と対応)
        // 日本語ラベル ('製造業') ではなく英語 ID ('manufacturing') を送る
        industry: 'manufacturing',
        adminName: '管理 太郎',
        adminEmail: 'newadmin@example.com',
        adminPassword: 'password123',
      }),
    );
    // 作成テナントは呼び出し元テナントとは別 ID
    expect(result.tenantId).not.toBe(CALLER_TENANT);
    // 作成テナントが store に存在し、業種 ID も保存されている
    const tenant = store.tenants.get(result.tenantId);
    expect(tenant?.name).toBe('新組織');
    // DB には industry ID が保存される (UI のラベル '製造業' ではなく)
    expect(tenant?.industry).toBe('manufacturing');
    // 初代管理者が作成テナントに admin として作られている
    const admin = [...store.users.values()].find((u) => u.email === 'newadmin@example.com');
    expect(admin?.role).toBe('admin');
    expect(admin?.tenantId).toBe(result.tenantId);
  });

  // 回帰防止: §7.2「30日間の Free trial (Standard 相当)」。新規テナントには
  // 作成時刻からおよそ 30 日後の trialEndsAt が設定されること
  it('trialEndsAt が作成時刻からおよそ30日後に設定される', async () => {
    const createTenant = await loadAction();
    const before = Date.now();
    const result = await createTenant(
      makeForm({
        tenantName: '新組織',
        industry: '',
        adminName: '管理 太郎',
        adminEmail: 'trial-admin@example.com',
        adminPassword: 'password123',
      }),
    );
    const tenant = store.tenants.get(result.tenantId);
    expect(tenant?.trialEndsAt).not.toBeNull();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const diff = tenant!.trialEndsAt!.getTime() - before;
    // 実行時間の揺れを許容しつつ、およそ 30 日後であることを確認する (前後 5 秒の許容誤差)
    expect(diff).toBeGreaterThan(THIRTY_DAYS_MS - 5000);
    expect(diff).toBeLessThan(THIRTY_DAYS_MS + 5000);
  });

  // 業種テンプレートの「よくある質問」が公開済み FAQ として初期投入されること (Phase 3)
  it('業種テンプレートの FAQ を公開済みとして投入する', async () => {
    const createTenant = await loadAction();
    const result = await createTenant(
      makeForm({
        tenantName: '新組織',
        industry: 'manufacturing',
        adminName: '管理 太郎',
        adminEmail: 'faqadmin@example.com',
        adminPassword: 'password123',
      }),
    );

    // manufacturing テンプレートの FAQ 2 件が作成テナントに投入されている
    const faqs = [...store.faq.values()].filter((f) => f.tenantId === result.tenantId);
    expect(faqs).toHaveLength(2);
    // すべて公開 (Published) 状態になっている (Candidate のまま放置されない)
    expect(faqs.every((f) => f.status === 'Published')).toBe(true);
    // それぞれの FAQ に紐づく元チケットが解決済み (Closed) で存在する
    for (const faq of faqs) {
      const ticket = store.tickets.get(faq.ticketId);
      expect(ticket?.status).toBe('Closed');
      expect(ticket?.tenantId).toBe(result.tenantId);
      // resolutionDueAt を設定しないこと (tickets.create は resolvedAt を常に null で作るため、
      // 期限だけ設定すると getSlaState() が Closed なのに「期限切れ」と誤判定してしまう回帰防止)
      expect(ticket?.resolutionDueAt).toBeNull();
    }
    // 質問文の内容も期待どおり (テンプレートの内容と一致)
    expect(faqs.map((f) => f.question)).toContain(
      '現場の PC が起動しません。どうすればいいですか？',
    );
  });

  // admin 以外は拒否されること (RBAC)
  it('admin 以外は拒否される', async () => {
    // 権限を agent に下げる
    sessionRole = 'agent';
    const createTenant = await loadAction();
    // 管理者専用のため拒否される
    await expect(
      createTenant(
        makeForm({
          tenantName: 'x',
          adminName: 'y',
          adminEmail: 'z@example.com',
          adminPassword: 'password123',
        }),
      ),
    ).rejects.toThrow(/管理者/);
  });

  // メール重複時はテナント作成もロールバックされること (孤児テナントを残さない)
  it('メール重複時はテナント作成もロールバックする', async () => {
    // 既存ユーザーを先に登録しておく (同じメール)
    await repos.users.create({
      email: 'dup@example.com',
      name: '既存',
      passwordHash: 'x',
      role: 'requester',
      tenantId: CALLER_TENANT,
    });
    // 作成前のテナント数を控える
    const before = store.tenants.size;
    const createTenant = await loadAction();
    // 重複のため拒否される
    await expect(
      createTenant(
        makeForm({
          tenantName: '失敗組織',
          adminName: '重複',
          adminEmail: 'dup@example.com',
          adminPassword: 'password123',
        }),
      ),
    ).rejects.toThrow(/既に登録/);
    // テナント数は増えていない (ロールバックされている)
    expect(store.tenants.size).toBe(before);
  });
});
