// escalateTicket が Slack/Teams/Chatwork 外部通知 (sendOutboundNotification) を送ることを検証する。
// 従来はステータス変更 (updateTicketStatus) にしか外部通知が配線されておらず、
// 対応漏れ防止のうえで最も重要なイベントであるエスカレーションだけがチーム共有チャネルに
// 届かない不整合があった。
// 主検証:
//   1. Slack Webhook 設定済みテナントでエスカレーションすると fetch が 1 回呼ばれる
//   2. 外部通知未設定テナントでエスカレーションしても fetch は呼ばれない (無駄打ちしない)
//   3. 外部通知の送信失敗はエスカレーション自体の成功に影響しない (ベストエフォート)

// Vitest の DSL とモック機能
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos/uow)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// 型のみ
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
// レート制限の履歴をテスト間でクリアする内部用関数
import { __resetRateLimits } from '@/lib/rate-limit';

// 主に使うテナント / ユーザー ID
const TENANT = 'default-tenant';
const AGENT = 'u-agt-1';
// テスト用 Slack Webhook URL (実際には送信されない。SSRF ガードを通す公開ホスト)
const SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/xxx';

// 各テストで差し替える可変な依存 (Action import 前に値を入れる)
let store: Store;
let repos: Repos;
let uow: UnitOfWork;
// fetch のモック関数 (Slack Adapter が呼ぶ)
let fetchMock: ReturnType<typeof vi.fn>;

// src/lib/webhook-fetch.ts は SSRF 対策の DNS 検証用 Dispatcher (Agent) を使うため
// undici の fetch を直接 import している。vi.stubGlobal('fetch', ...) だけでは差し替わらない
// ため、undici の fetch を globalThis.fetch (下の beforeEach で差し替える) へ委譲するモックにする
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

// セッションはエージェントで固定 (エスカレーションはエージェント以上のみ実行可)
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: AGENT, role: 'agent' as const, tenantId: TENANT },
  }),
}));

// next/cache の副作用は不要なので spy で潰す
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

// SSE ブロードキャストもテストでは不要
vi.mock('@/lib/sse-subscribers', () => ({
  broadcast: vi.fn(),
}));

// エスカレーションメール送信 (別経路) はテストの主眼ではないため no-op にする
vi.mock('@/lib/email', () => ({
  getEmailSender: () => ({ send: async () => {} }),
}));

// テナント + エージェント + Escalated 遷移可能な Open チケットを 1 件投入するヘルパー。
// slackWebhookUrl だけを差し替えられるようにする
async function seed(slackWebhookUrl: string | null): Promise<{ ticketId: string }> {
  const now = new Date();
  // Pro モード固定 (Lite ではエスカレーション機能自体が無効)
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode: 'pro',
    industry: null,
    inboundToken: null,
    slackWebhookUrl,
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
  // エージェントユーザーを投入
  store.users.set(AGENT, {
    id: AGENT,
    email: 'agent@example.com',
    name: '担当者',
    passwordHash: 'x',
    role: 'agent',
    tenantId: TENANT,
    createdAt: now,
    updatedAt: now,
  });
  // 依頼者ユーザーを投入 (チケット起票者)
  store.users.set('u-req-1', {
    id: 'u-req-1',
    email: 'requester@example.com',
    name: '依頼者',
    passwordHash: 'x',
    role: 'requester',
    tenantId: TENANT,
    createdAt: now,
    updatedAt: now,
  });
  // 検証対象チケットを作成し、Open へ遷移させる (Open → Escalated は遷移表で許可)
  const ticket = await repos.tickets.create({
    title: 'サーバーがダウンした',
    body: '本番環境が応答しません',
    priority: 'High',
    creatorId: 'u-req-1',
    categoryId: null,
    tenantId: TENANT,
  });
  await repos.tickets.updateStatus(ticket.id, { from: 'New', to: 'Open' }, null, TENANT);
  return { ticketId: ticket.id };
}

beforeEach(() => {
  // 毎回新しい context を作って独立な状態にする
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  uow = ctx.uow;
  // 動的 import の結果をリセット (mock 設定を反映させるため)
  vi.resetModules();
  // レート制限の履歴をクリア (前テストの呼び出し回数を引きずらない)
  __resetRateLimits();
  // fetch は常にモックし、成功レスポンスを返す (Slack Adapter が呼ぶ)
  fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('ok') });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('escalateTicket (外部通知)', () => {
  it('Slack Webhook 設定済みテナントでエスカレーションすると Slack へ通知される', async () => {
    const { ticketId } = await seed(SLACK_WEBHOOK_URL);
    const { escalateTicket } = await import('@/features/tickets/actions/update-ticket');

    await escalateTicket(ticketId, '対応困難のため引き継ぎ');

    // エスカレーション自体は成功する
    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.status).toBe('Escalated');
    // Slack Webhook へ 1 回だけ POST される
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SLACK_WEBHOOK_URL);
    // 通知本文にチケット件名が含まれる
    const payload = JSON.parse(init.body);
    const texts = JSON.stringify(payload);
    expect(texts).toContain('サーバーがダウンした');
  });

  it('外部通知が未設定のテナントでエスカレーションしても fetch は呼ばれない', async () => {
    const { ticketId } = await seed(null);
    const { escalateTicket } = await import('@/features/tickets/actions/update-ticket');

    await escalateTicket(ticketId, '対応困難のため引き継ぎ');

    // 通知チャネルが 1 つも設定されていないため fetch は呼ばれない
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('外部通知の送信失敗はエスカレーション自体の成功に影響しない', async () => {
    const { ticketId } = await seed(SLACK_WEBHOOK_URL);
    // Slack への送信を失敗させる (ネットワークエラーを模擬)
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { escalateTicket } = await import('@/features/tickets/actions/update-ticket');

    // 例外を投げずに完了すること (ベストエフォート)
    await expect(escalateTicket(ticketId, '対応困難のため引き継ぎ')).resolves.toBeUndefined();

    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.status).toBe('Escalated');
  });
});
