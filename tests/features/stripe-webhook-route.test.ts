// POST /api/webhooks/stripe (Phase 4 課金 Webhook) のテスト。
// Stripe 署名検証・Stripe クライアントは @/lib/stripe をモックして回避し、
// テナントのプラン更新と、ダウングレード時に Pro モードを強制解除する挙動を検証する (DB は持ち込まない)。
//
// 検証の背景: 以前は subscriptionPlan だけを更新し tenant.mode は変更していなかったため、
// Pro モードで運用していたテナントが解約/ダウングレードしても mode='pro' のまま残り、
// エスカレーション等の Pro 専用機能が使い続けられてしまう不備があった。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
// システムアクター (actorId=null) の表示名。ハードコードせず一元管理定数と突き合わせる
import { SETTINGS_AUDIT_SYSTEM_ACTOR_NAME } from '@/lib/constants';

const TENANT = 'default-tenant';

// 各テストで差し替える可変な依存 (Route import 前に値を入れる)
let store: Store;
let repos: Repos;
let uow: UnitOfWork;

// @/data を差し替え (getter で beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
  get uow() {
    return uow;
  },
}));

// Stripe SDK 呼び出し (署名検証・Price ID→プラン判定) をモックする。
// vi.hoisted で先に用意することで、vi.mock のファクトリから参照できるようにする (巻き上げ順序対策)。
// planForNextCall でテストごとに「今回のイベントで判定させたいプラン」を差し替える
const { planForNextCall } = vi.hoisted(() => ({
  planForNextCall: { current: 'pro' as 'free' | 'standard' | 'pro' },
}));
vi.mock('@/lib/stripe', () => ({
  // 署名検証はモックし、リクエストボディの JSON をそのまま Stripe イベントとして扱う
  getStripeClient: () => ({
    webhooks: {
      constructEvent: (rawBody: string) => JSON.parse(rawBody),
    },
  }),
  getStripeWebhookSecret: () => 'whsec_test',
  // 本来は status + priceId から判定するが、テストでは明示的に差し替えて挙動を固定する
  stripeStatusToPlan: () => planForNextCall.current,
}));

// テナントをシードする (mode / plan を指定可能)
function seedTenant(mode: 'lite' | 'pro', plan: 'free' | 'standard' | 'pro' | 'enterprise'): void {
  const now = new Date();
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode,
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    subscriptionPlan: plan,
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    stripeSubscriptionStatus: 'active',
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    createdAt: now,
  });
}

// Stripe イベント JSON + 署名ヘッダ (値は何でもよい。constructEvent はモック済み) を組み立てる
function makeRequest(eventBody: Record<string, unknown>): Request {
  return new Request('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
    body: JSON.stringify(eventBody),
  });
}

describe('POST /api/webhooks/stripe', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    uow = ctx.uow;
    planForNextCall.current = 'pro';
  });

  // 解約 (customer.subscription.deleted) で Pro → Free に降格すると、Pro モードも強制的に lite へ戻る
  it('Pro テナントが解約されると Free に降格し、mode も lite に戻す', async () => {
    seedTenant('pro', 'pro');
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      makeRequest({
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'canceled',
            metadata: { tenantId: TENANT },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const tenant = store.tenants.get(TENANT)!;
    expect(tenant.subscriptionPlan).toBe('free');
    expect(tenant.mode).toBe('lite');
    // §4.3 フォローアップ: 自動ダウングレードによる mode 強制変更も監査ログに残ること
    // (actorId は操作したユーザーが存在しないため null = システムアクター)
    const auditLogs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('tenant_mode_update');
    expect(auditLogs[0].actorId).toBeNull();
    expect(auditLogs[0].actorName).toBe(SETTINGS_AUDIT_SYSTEM_ACTOR_NAME);
  });

  // 更新イベント (customer.subscription.updated) で Pro → Standard にダウングレードしても同様
  it('Pro テナントが Standard にダウングレードされると mode も lite に戻す', async () => {
    seedTenant('pro', 'pro');
    planForNextCall.current = 'standard';
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      makeRequest({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'active',
            items: { data: [{ price: { id: 'price_standard' } }] },
            metadata: { tenantId: TENANT },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const tenant = store.tenants.get(TENANT)!;
    expect(tenant.subscriptionPlan).toBe('standard');
    expect(tenant.mode).toBe('lite');
  });

  // Pro のまま更新される (昇格/継続) 場合は mode を変更しない
  it('Pro のまま更新されるときは mode を変更しない', async () => {
    seedTenant('pro', 'pro');
    planForNextCall.current = 'pro';
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      makeRequest({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'active',
            items: { data: [{ price: { id: 'price_pro' } }] },
            metadata: { tenantId: TENANT },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const tenant = store.tenants.get(TENANT)!;
    expect(tenant.subscriptionPlan).toBe('pro');
    expect(tenant.mode).toBe('pro');
    // mode が変わっていないので監査ログも記録されない (無関係なイベントで監査ログを埋めない)
    expect(await repos.settingsAudit.findAllByTenant({ tenantId: TENANT })).toHaveLength(0);
  });

  // 既に Lite モードのテナントがダウングレードしても、mode は変更不要 (既に lite) のまま
  it('Lite モードのテナントがダウングレードしても mode はそのまま', async () => {
    seedTenant('lite', 'standard');
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      makeRequest({
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'canceled',
            metadata: { tenantId: TENANT },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const tenant = store.tenants.get(TENANT)!;
    expect(tenant.subscriptionPlan).toBe('free');
    expect(tenant.mode).toBe('lite');
  });

  // Enterprise は Stripe 管理外: 解約イベントが来てもプランを降格せず、mode も変更しない
  it('Enterprise テナントは解約イベントでもプランを降格せず mode も変更しない', async () => {
    seedTenant('pro', 'enterprise');
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      makeRequest({
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'canceled',
            metadata: { tenantId: TENANT },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const tenant = store.tenants.get(TENANT)!;
    expect(tenant.subscriptionPlan).toBe('enterprise');
    expect(tenant.mode).toBe('pro');
  });

  // 署名ヘッダが無いリクエストは 400 で拒否する (なりすまし対策)
  it('stripe-signature ヘッダが無ければ 400 を返す', async () => {
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const req = new Request('http://localhost/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'customer.subscription.deleted', data: { object: {} } }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
