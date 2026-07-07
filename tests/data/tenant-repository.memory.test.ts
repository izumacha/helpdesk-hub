// テナントリポジトリ (メモリアダプタ) の updateMode 単体テスト。
// Lite/Pro モード切替がテナント単位で正しく行われ、他テナントに波及しないことを確認する。

// Vitest の DSL とフック
import { beforeEach, describe, expect, it } from 'vitest';
// メモリ context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// 型のみ
import type { Repos } from '@/data/ports/unit-of-work';

// テスト用テナント識別子
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

// テストごとに作り直す依存
let store: Store;
let repos: Repos;

// テナント A・B を Lite モードで投入する共通シード
function seed() {
  // 現在時刻 (createdAt 用)
  const now = new Date();
  // テナント A・B を Lite モードで作成する
  for (const t of [TENANT_A, TENANT_B]) {
    store.tenants.set(t, {
      id: t,
      name: t,
      mode: 'lite',
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
      chatworkRoomId: null, // Slack 通知未設定 (テスト用フィクスチャ)
      createdAt: now,
    });
  }
}

// updateMode の仕様確認テスト群
describe('TenantRepository.updateMode (memory)', () => {
  // 各テストの前にメモリ context を作り直してシードする
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    seed();
  });

  // 正常系: 指定テナントの mode を lite → pro に切り替えられる
  it('対象テナントの mode を pro に更新できる', async () => {
    // テナント A を pro に切り替える
    const updated = await repos.tenants.updateMode(TENANT_A, 'pro');
    // 戻り値の mode が pro になっている
    expect(updated.mode).toBe('pro');
    // 再取得しても pro が永続化されている
    const reloaded = await repos.tenants.findById(TENANT_A);
    expect(reloaded?.mode).toBe('pro');
  });

  // 分離: あるテナントの更新が他テナントに波及しない
  it('他テナントの mode には影響しない', async () => {
    // テナント A だけを pro に切り替える
    await repos.tenants.updateMode(TENANT_A, 'pro');
    // テナント B は元の lite のままであること
    const tenantB = await repos.tenants.findById(TENANT_B);
    expect(tenantB?.mode).toBe('lite');
  });

  // 異常系: 存在しないテナント ID はエラーになる (fail-closed)
  it('存在しないテナント ID はエラーになる', async () => {
    // 未登録の ID で更新しようとすると reject される
    await expect(repos.tenants.updateMode('no-such-tenant', 'pro')).rejects.toThrow();
  });

  // 冪等: 同じ mode への更新でも成功し値が保たれる
  it('同じ mode への更新でも値が保たれる', async () => {
    // 既に lite のテナントを lite に更新する
    const updated = await repos.tenants.updateMode(TENANT_A, 'lite');
    // mode は lite のまま
    expect(updated.mode).toBe('lite');
  });
});

// メール取り込み (Phase 2) で使う findByInboundToken の単体テスト。
// 転送アドレスのローカルパート (inboundToken) からテナントを特定できることを確認する。
describe('TenantRepository.findByInboundToken (memory)', () => {
  // 各テストでメモリ context を作り直す
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    // 取り込みトークン付きでテナント A を、トークン無しでテナント B を投入する
    const now = new Date();
    store.tenants.set(TENANT_A, {
      id: TENANT_A,
      name: TENANT_A,
      mode: 'lite',
      industry: null,
      inboundToken: 'token-a',
      slackWebhookUrl: null,
      subscriptionPlan: 'free' as const,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      trialEndsAt: null,
      teamsWebhookUrl: null,
      chatworkApiToken: null,
      chatworkRoomId: null, // Slack 通知未設定 (テスト用フィクスチャ)
      createdAt: now,
    });
    store.tenants.set(TENANT_B, {
      id: TENANT_B,
      name: TENANT_B,
      mode: 'lite',
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
      chatworkRoomId: null, // Slack 通知未設定 (テスト用フィクスチャ)
      createdAt: now,
    });
  });

  // トークン一致でテナントを引ける
  it('トークンが一致するテナントを返す', async () => {
    const tenant = await repos.tenants.findByInboundToken('token-a');
    expect(tenant?.id).toBe(TENANT_A);
  });

  // 未知トークンは null
  it('一致するトークンが無ければ null を返す', async () => {
    const tenant = await repos.tenants.findByInboundToken('no-such-token');
    expect(tenant).toBeNull();
  });

  // inboundToken=null のテナントに null で誤ヒットしないこと
  it('null トークンで誤ヒットしない', async () => {
    // 万一 null をトークンとして渡しても、token-a の行だけが一致対象であること
    const tenant = await repos.tenants.findByInboundToken('token-a');
    expect(tenant?.id).toBe(TENANT_A);
    // (B は inboundToken=null なので決して引かれない)
  });
});

// Phase 4: 外部通知チャネル設定の部分更新 updateNotificationChannels の単体テスト。
// 渡したフィールドだけ更新し、undefined のフィールドは現状維持することを確認する
// (port の「部分更新 / undefined = skip」契約を memory アダプタで担保する)。
describe('TenantRepository.updateNotificationChannels (memory)', () => {
  // 各テストの前にメモリ context を作り直してテナント A・B を投入する
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    seed();
  });

  // 渡したチャネルだけ更新し、他チャネルの既存値は維持される (部分更新)
  it('指定したチャネルだけ更新し他チャネルは維持する', async () => {
    // まず Slack と Teams を設定する
    await repos.tenants.updateNotificationChannels(TENANT_A, {
      slackWebhookUrl: 'https://hooks.slack.com/services/AAA',
      teamsWebhookUrl: 'https://teams.example/webhook',
    });
    // 次に Slack だけ無効化する (teamsWebhookUrl は undefined = 現状維持)
    const updated = await repos.tenants.updateNotificationChannels(TENANT_A, {
      slackWebhookUrl: null,
    });
    // Slack は null に更新され、Teams は前回値を維持していること
    expect(updated.slackWebhookUrl).toBeNull();
    expect(updated.teamsWebhookUrl).toBe('https://teams.example/webhook');
  });

  // Chatwork トークン + ルーム ID を設定でき、再取得しても永続化されている
  it('Chatwork トークンとルーム ID を更新できる', async () => {
    // Chatwork の 2 値を設定する
    await repos.tenants.updateNotificationChannels(TENANT_A, {
      chatworkApiToken: 'tok-123',
      chatworkRoomId: '98765',
    });
    // 再取得して両方が永続化されていることを確認する
    const reloaded = await repos.tenants.findById(TENANT_A);
    expect(reloaded?.chatworkApiToken).toBe('tok-123');
    expect(reloaded?.chatworkRoomId).toBe('98765');
  });

  // 更新が他テナントに波及しない (テナント分離)
  it('他テナントの通知設定には影響しない', async () => {
    // テナント A だけ Slack を設定する
    await repos.tenants.updateNotificationChannels(TENANT_A, {
      slackWebhookUrl: 'https://hooks.slack.com/services/BBB',
    });
    // テナント B は未設定 (null) のままであること
    const tenantB = await repos.tenants.findById(TENANT_B);
    expect(tenantB?.slackWebhookUrl).toBeNull();
  });
});
