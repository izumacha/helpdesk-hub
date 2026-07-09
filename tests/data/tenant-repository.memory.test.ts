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

// メール取り込み用トークンの (再)発行 updateInboundToken の単体テスト。
// 未発行テナントへの初回発行、既存トークンからの再発行 (ローテーション)、
// テナント分離、存在しない ID の fail-closed を確認する。
describe('TenantRepository.updateInboundToken (memory)', () => {
  // 各テストの前にメモリ context を作り直してテナント A・B を投入する
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    seed();
  });

  // 未発行 (null) のテナントに新しいトークンを発行できる
  it('未発行テナントにトークンを発行できる', async () => {
    const updated = await repos.tenants.updateInboundToken(TENANT_A, 'newtoken123');
    expect(updated.inboundToken).toBe('newtoken123');
    // 再取得しても永続化されている
    const reloaded = await repos.tenants.findById(TENANT_A);
    expect(reloaded?.inboundToken).toBe('newtoken123');
  });

  // 既存トークンを新しい値へ差し替えられる (漏洩時のローテーション用途)
  it('既存トークンを新しい値に再発行できる', async () => {
    await repos.tenants.updateInboundToken(TENANT_A, 'oldtoken111');
    const updated = await repos.tenants.updateInboundToken(TENANT_A, 'newtoken222');
    expect(updated.inboundToken).toBe('newtoken222');
    // 旧トークンではもうテナントを特定できない
    const byOldToken = await repos.tenants.findByInboundToken('oldtoken111');
    expect(byOldToken).toBeNull();
  });

  // 分離: あるテナントの再発行が他テナントに波及しない
  it('他テナントの inboundToken には影響しない', async () => {
    await repos.tenants.updateInboundToken(TENANT_A, 'tokenfora001');
    const tenantB = await repos.tenants.findById(TENANT_B);
    expect(tenantB?.inboundToken).toBeNull();
  });

  // 異常系: 存在しないテナント ID はエラーになる (fail-closed)
  it('存在しないテナント ID はエラーになる', async () => {
    await expect(repos.tenants.updateInboundToken('no-such-tenant', 'x')).rejects.toThrow();
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

// §7.2 Free trial 終了リマインダー用の listActiveTrials の単体テスト。
// free プランかつトライアル進行中のテナントだけを、上限件数・終了が近い順で返すことを確認する。
describe('TenantRepository.listActiveTrials (memory)', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
  });

  // 指定の subscriptionPlan / trialEndsAt でテナントを 1 件シードする
  function seedTrialTenant(
    id: string,
    subscriptionPlan: 'free' | 'standard',
    trialEndsAt: Date | null,
  ) {
    store.tenants.set(id, {
      id,
      name: id,
      mode: 'lite',
      industry: null,
      inboundToken: null,
      slackWebhookUrl: null,
      subscriptionPlan,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      trialEndsAt,
      teamsWebhookUrl: null,
      chatworkApiToken: null,
      chatworkRoomId: null,
      createdAt: new Date(),
    });
  }

  // free プランかつトライアル進行中 (trialEndsAt > now) のテナントだけを返す
  it('freeプランかつトライアル進行中のテナントのみ返す', async () => {
    const now = new Date('2026-07-01T00:00:00Z');
    seedTrialTenant('trial-active', 'free', new Date('2026-07-05T00:00:00Z')); // 対象
    seedTrialTenant('trial-expired', 'free', new Date('2026-06-25T00:00:00Z')); // 既に終了
    seedTrialTenant('no-trial', 'free', null); // トライアル対象外
    seedTrialTenant('standard-plan', 'standard', new Date('2026-07-05T00:00:00Z')); // 有料プラン
    const result = await repos.tenants.listActiveTrials(now, 100);
    expect(result.map((t) => t.id)).toEqual(['trial-active']);
  });

  // 終了が近い順 (trialEndsAt 昇順) に並ぶこと
  it('終了が近い順に並べる', async () => {
    const now = new Date('2026-07-01T00:00:00Z');
    seedTrialTenant('far', 'free', new Date('2026-07-20T00:00:00Z'));
    seedTrialTenant('near', 'free', new Date('2026-07-05T00:00:00Z'));
    const result = await repos.tenants.listActiveTrials(now, 100);
    expect(result.map((t) => t.id)).toEqual(['near', 'far']);
  });

  // 上限件数で切り詰めること (§8 一覧取得は必ず上限を持たせる)
  it('上限件数で切り詰める', async () => {
    const now = new Date('2026-07-01T00:00:00Z');
    seedTrialTenant('t1', 'free', new Date('2026-07-05T00:00:00Z'));
    seedTrialTenant('t2', 'free', new Date('2026-07-06T00:00:00Z'));
    seedTrialTenant('t3', 'free', new Date('2026-07-07T00:00:00Z'));
    const result = await repos.tenants.listActiveTrials(now, 2);
    expect(result).toHaveLength(2);
  });
});
