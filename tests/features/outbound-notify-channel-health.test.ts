// sendOutboundNotification (src/lib/outbound-notify.ts) のチャネル健全性記録の仕様確認テスト。
// 監査で発見したギャップ: 外部通知チャネル (Slack/Teams/Chatwork) の送信失敗はこれまで
// サーバーログにしか残らず、管理者は Webhook URL の失効・トークン失効に気づく手段が無かった。
// 失敗時に Tenant.slackLastFailureAt/Message 等へ記録し、次回成功時にクリアすることを検証する。

// Vitest の DSL とモック機能
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos/uow)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// 型のみ
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';

// テスト用テナント ID と Slack Webhook URL (実際には送信されない。SSRF ガードを通す公開ホスト)
const TENANT = 'default-tenant';
const SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/xxx';

// 各テストで差し替える可変な依存 (動的 import 前に値を入れる)
let store: Store;
let repos: Repos;
let uow: UnitOfWork;
// fetch のモック関数 (Slack Adapter が呼ぶ)
let fetchMock: ReturnType<typeof vi.fn>;

// src/lib/webhook-fetch.ts は undici の fetch を直接 import しているため、
// vi.stubGlobal('fetch', ...) だけでは差し替わらない (create-ticket-outbound-notify.test.ts と同じ手法)
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: ((...args: Parameters<typeof globalThis.fetch>) =>
      globalThis.fetch(...args)) as unknown as typeof actual.fetch,
  };
});

// @/data モジュールを差し替え (getter で参照することで beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
  get uow() {
    return uow;
  },
}));

// Slack Webhook 設定済みのテナントを 1 件投入する
async function seedTenant() {
  const now = new Date();
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode: 'lite',
    industry: null,
    inboundToken: null,
    slackWebhookUrl: SLACK_WEBHOOK_URL,
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
}

beforeEach(() => {
  // 毎回新しい context を作って独立な状態にする
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  uow = ctx.uow;
  // 動的 import の結果をリセット (mock 設定を反映させるため)
  vi.resetModules();
  // fetch は既定で成功させる (各テストで必要に応じて reject させる)
  fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('ok') });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendOutboundNotification のチャネル健全性記録', () => {
  it('送信失敗時に直近の失敗日時とメッセージを記録する', async () => {
    await seedTenant();
    // Slack Webhook への送信を失敗させる (ネットワークエラーを模擬)
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { sendOutboundNotification } = await import('@/lib/outbound-notify');

    await sendOutboundNotification(TENANT, { subject: '件名', body: '本文' });

    const tenant = await repos.tenants.findById(TENANT);
    expect(tenant?.slackLastFailureAt).toBeInstanceOf(Date);
    expect(tenant?.slackLastFailureMessage).toContain('network down');
  });

  it('失敗記録がある状態で次回送信が成功すると記録がクリアされる', async () => {
    await seedTenant();
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { sendOutboundNotification } = await import('@/lib/outbound-notify');

    // 1 回目: 失敗して記録される
    await sendOutboundNotification(TENANT, { subject: '件名1', body: '本文1' });
    const afterFailure = await repos.tenants.findById(TENANT);
    expect(afterFailure?.slackLastFailureAt).not.toBeNull();

    // 2 回目: Webhook URL を直したので成功する (fetchMock は既定で成功を返す)
    await sendOutboundNotification(TENANT, { subject: '件名2', body: '本文2' });
    const afterSuccess = await repos.tenants.findById(TENANT);
    expect(afterSuccess?.slackLastFailureAt).toBeNull();
    expect(afterSuccess?.slackLastFailureMessage).toBeNull();
  });

  it('失敗記録が無い状態で成功しても余分な書き込みをしない (§8 パフォーマンス)', async () => {
    await seedTenant();
    const { sendOutboundNotification } = await import('@/lib/outbound-notify');
    // recordOutboundChannelResult の呼び出し回数を監視する
    const recordSpy = vi.spyOn(repos.tenants, 'recordOutboundChannelResult');

    await sendOutboundNotification(TENANT, { subject: '件名', body: '本文' });

    // 前回失敗が無いので、成功時にわざわざ DB を書きに行かない
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('健全性記録自体が失敗しても送信結果の処理は継続する (非クリティカルな副作用)', async () => {
    await seedTenant();
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { sendOutboundNotification } = await import('@/lib/outbound-notify');
    // 記録処理そのものを失敗させる (例: DB 接続断)
    vi.spyOn(repos.tenants, 'recordOutboundChannelResult').mockRejectedValueOnce(
      new Error('DB down'),
    );
    // 想定内のログ出力なのでコンソールを黙らせる
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 記録処理の失敗が外へ伝播せず、呼び出し元からは正常終了に見えること
    await expect(
      sendOutboundNotification(TENANT, { subject: '件名', body: '本文' }),
    ).resolves.toBeUndefined();

    consoleErrorSpy.mockRestore();
  });
});
