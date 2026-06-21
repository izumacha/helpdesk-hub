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
      slackWebhookUrl: null, subscriptionPlan: 'free' as const, stripeCustomerId: null, stripeSubscriptionId: null, stripeSubscriptionStatus: null, // Slack 通知未設定 (テスト用フィクスチャ)
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
