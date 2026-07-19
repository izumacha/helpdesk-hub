// updateNotificationChannels (Server Action) のテスト。
// 管理者ゲート・SSRF ガード・Chatwork 入力検証・レート制限をメモリアダプタで検証する。
// これまでこのアクションにテストが存在しなかったギャップを埋める。

// Vitest の DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束の型
import type { Repos } from '@/data/ports/unit-of-work';
// レート制限バケットをテスト間で初期化するヘルパー
import { __resetRateLimits } from '@/lib/rate-limit';

const TENANT_ID = 'tenant-1';
const ADMIN_ID = 'u-admin-1';

// 各テストで差し替える可変な依存 (Action import 前に値を入れる)
let store: Store;
let repos: Repos;
// 認証モックが返すセッション (テストごとに差し替える)
let sessionUser: { id: string; role: string; tenantId: string | null } | null;

// @/data を差し替え (getter で beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// 認証はテストごとに差し替え可能なセッションを返すモックに置換
vi.mock('@/lib/auth', () => ({
  auth: async () => (sessionUser ? { user: sessionUser } : null),
}));

// next/cache の副作用 (revalidatePath) はテストでは不要
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// FormData を組み立てるヘルパー (未指定フィールドは空欄送信扱い)
function makeForm(input: {
  slackWebhookUrl?: string;
  teamsWebhookUrl?: string;
  chatworkApiToken?: string;
  chatworkRoomId?: string;
}): FormData {
  const fd = new FormData();
  fd.set('slackWebhookUrl', input.slackWebhookUrl ?? '');
  fd.set('teamsWebhookUrl', input.teamsWebhookUrl ?? '');
  fd.set('chatworkApiToken', input.chatworkApiToken ?? '');
  fd.set('chatworkRoomId', input.chatworkRoomId ?? '');
  return fd;
}

// テナントを最小構成でシードする
function seedTenant() {
  store.tenants.set(TENANT_ID, {
    id: TENANT_ID,
    name: 'テスト組織',
    mode: 'lite',
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    subscriptionPlan: 'pro',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    createdAt: new Date(),
  });
}

describe('updateNotificationChannels', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    sessionUser = { id: ADMIN_ID, role: 'admin', tenantId: TENANT_ID };
    seedTenant();
    __resetRateLimits();
  });

  // 未ログイン (tenantId 不在) は拒否される
  it('tenantIdが無いセッションは拒否される', async () => {
    sessionUser = { id: ADMIN_ID, role: 'admin', tenantId: null };
    const { updateNotificationChannels } =
      await import('@/features/settings/actions/update-notification-channels');
    const result = await updateNotificationChannels({}, makeForm({}));
    expect(result.error).toBe('認証が必要です');
  });

  // admin 以外は拒否される
  it('agent ロールは拒否される', async () => {
    sessionUser = { id: 'u-agent-1', role: 'agent', tenantId: TENANT_ID };
    const { updateNotificationChannels } =
      await import('@/features/settings/actions/update-notification-channels');
    const result = await updateNotificationChannels({}, makeForm({}));
    expect(result.error).toBe('この操作は管理者のみ実行できます');
  });

  // 妥当な Slack Webhook URL は保存できる
  it('妥当なSlack Webhook URLを保存できる', async () => {
    const { updateNotificationChannels } =
      await import('@/features/settings/actions/update-notification-channels');
    const result = await updateNotificationChannels(
      {},
      makeForm({ slackWebhookUrl: 'https://hooks.slack.com/services/xxx' }),
    );
    expect(result.success).toBe(true);
    const saved = await repos.tenants.findById(TENANT_ID);
    expect(saved?.slackWebhookUrl).toBe('https://hooks.slack.com/services/xxx');
    // §4.2 フォローアップ: 監査ログに記録されること
    const auditLogs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_ID });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('notification_channels_update');
  });

  // https 以外の Webhook URL は拒否される
  it('httpsで始まらないWebhook URLは拒否される', async () => {
    const { updateNotificationChannels } =
      await import('@/features/settings/actions/update-notification-channels');
    const result = await updateNotificationChannels(
      {},
      makeForm({ slackWebhookUrl: 'http://hooks.slack.com/services/xxx' }),
    );
    expect(result.error).toBe('Slack の Webhook URL は https:// で始まる必要があります');
  });

  // SSRF 対策: プライベート IP 宛の Webhook URL は拒否される
  it('内部ネットワーク宛のWebhook URLは拒否される', async () => {
    const { updateNotificationChannels } =
      await import('@/features/settings/actions/update-notification-channels');
    const result = await updateNotificationChannels(
      {},
      makeForm({ teamsWebhookUrl: 'https://169.254.169.254/latest/meta-data' }),
    );
    expect(result.error).toBe('Teams に内部ネットワークの Webhook URL は設定できません');
  });

  // Chatwork はトークン・ルーム ID を対で入力する必要がある
  it('Chatworkはトークンだけの入力だと拒否される', async () => {
    const { updateNotificationChannels } =
      await import('@/features/settings/actions/update-notification-channels');
    const result = await updateNotificationChannels({}, makeForm({ chatworkApiToken: 'tok123' }));
    expect(result.error).toBe('Chatwork は API トークンとルーム ID の両方を入力してください');
  });

  // Chatwork ルーム ID は数字以外を拒否する (パスインジェクション対策)
  it('Chatworkルーム IDが数字以外だと拒否される', async () => {
    const { updateNotificationChannels } =
      await import('@/features/settings/actions/update-notification-channels');
    const result = await updateNotificationChannels(
      {},
      makeForm({ chatworkApiToken: 'tok123', chatworkRoomId: '123/../etc' }),
    );
    expect(result.error).toBe('Chatwork ルーム ID は数字で入力してください');
  });

  // Chatwork ルーム ID はちょうど上限(200文字)なら保存できる (境界値)
  it('Chatworkルーム IDがちょうど200文字なら保存できる', async () => {
    const { updateNotificationChannels } =
      await import('@/features/settings/actions/update-notification-channels');
    const roomId200 = '1'.repeat(200);
    const result = await updateNotificationChannels(
      {},
      makeForm({ chatworkApiToken: 'tok123', chatworkRoomId: roomId200 }),
    );
    expect(result.success).toBe(true);
    const saved = await repos.tenants.findById(TENANT_ID);
    expect(saved?.chatworkRoomId).toBe(roomId200);
  });

  // Chatwork ルーム ID は上限(200文字)を1文字でも超えると拒否される (境界値)
  it('Chatworkルーム IDが201文字だと拒否される', async () => {
    const { updateNotificationChannels } =
      await import('@/features/settings/actions/update-notification-channels');
    const roomId201 = '1'.repeat(201);
    const result = await updateNotificationChannels(
      {},
      makeForm({ chatworkApiToken: 'tok123', chatworkRoomId: roomId201 }),
    );
    expect(result.error).toBe('Chatwork ルーム ID は数字で入力してください');
  });

  // 監査で発見したギャップ対応: Webhook URL を修正して保存すると、その場ですぐに
  // 直近の失敗記録 (「⚠️ 最終送信失敗」バッジ) がクリアされる (次の送信成功を待たない)
  it('チャネルの設定値を変更すると直近の失敗記録がクリアされる', async () => {
    // あらかじめ Slack の失敗を記録しておく (前回の Webhook URL が壊れていた想定)
    await repos.tenants.recordOutboundChannelResult(TENANT_ID, 'slack', {
      message: 'HTTP 404',
      at: new Date(),
    });
    const { updateNotificationChannels } =
      await import('@/features/settings/actions/update-notification-channels');
    // 正しい URL に修正して保存する
    const result = await updateNotificationChannels(
      {},
      makeForm({ slackWebhookUrl: 'https://hooks.slack.com/services/fixed' }),
    );
    expect(result.success).toBe(true);
    const saved = await repos.tenants.findById(TENANT_ID);
    // 失敗記録が消えていること (次の送信成功を待たずにバッジが消える)
    expect(saved?.slackLastFailureAt ?? null).toBeNull();
    expect(saved?.slackLastFailureMessage ?? null).toBeNull();
  });

  // 触っていないチャネルの失敗記録は残る (実際に直したわけではないため)
  it('変更していないチャネルの失敗記録は保持される', async () => {
    // Slack はあらかじめ正しい URL で設定済み・失敗記録もある状態にする
    await repos.tenants.updateNotificationChannels(TENANT_ID, {
      slackWebhookUrl: 'https://hooks.slack.com/services/unchanged',
    });
    await repos.tenants.recordOutboundChannelResult(TENANT_ID, 'slack', {
      message: 'HTTP 500',
      at: new Date(),
    });
    const { updateNotificationChannels } =
      await import('@/features/settings/actions/update-notification-channels');
    // Slack の値は変えずに、フォームを再送信する (実質同じ値で保存)
    const result = await updateNotificationChannels(
      {},
      makeForm({ slackWebhookUrl: 'https://hooks.slack.com/services/unchanged' }),
    );
    expect(result.success).toBe(true);
    const saved = await repos.tenants.findById(TENANT_ID);
    // 値を変えていないので、失敗記録は消えずに残っている
    expect(saved?.slackLastFailureAt).not.toBeNull();
  });

  // レート制限: 60秒あたり10回を超える連打は拒否される
  it('60秒あたり10回を超える連打は拒否される', async () => {
    const { updateNotificationChannels } =
      await import('@/features/settings/actions/update-notification-channels');
    for (let i = 0; i < 10; i++) {
      const result = await updateNotificationChannels({}, makeForm({}));
      expect(result.error).toBeUndefined();
    }
    const result = await updateNotificationChannels({}, makeForm({}));
    expect(result.error).toEqual(expect.any(String));
    expect(result.success).toBeUndefined();
  });
});
