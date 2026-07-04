// POST /api/tickets を叩いたとき、Phase 4 の Slack/Teams/Chatwork 外部通知が
// 新規問い合わせ作成時にも送信されることを検証する。
// 従来はステータス変更時 (update-ticket.ts) にしか送信されず、SMB の一次利用シーン
// である「新規問い合わせが届いたらすぐ Slack で気づける」が満たせていなかった。
// 主検証:
//   1. Slack Webhook 設定済みテナントで起票すると fetch が 1 回呼ばれる
//   2. 外部通知未設定テナントで起票しても fetch は呼ばれない (無駄打ちしない)
//   3. 外部通知の送信失敗はチケット作成のレスポンスに影響しない (ベストエフォート)

// Vitest の DSL とモック機能
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos/uow)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// 型のみ
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';

// 主に使うテナント ID と依頼者 ID
const TENANT = 'default-tenant';
const REQUESTER = 'u-req-1';
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

// セッションは依頼者で固定 (Lite モードで起票する)
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: REQUESTER, role: 'requester' as const, tenantId: TENANT },
  }),
}));

// テナントを 1 件投入するヘルパー。slackWebhookUrl だけを差し替えられるようにする
async function seedTenant(slackWebhookUrl: string | null) {
  const now = new Date();
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode: 'lite',
    industry: null,
    inboundToken: null,
    slackWebhookUrl,
    subscriptionPlan: 'free' as const,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    createdAt: now,
  });
  // 依頼者ユーザーを投入
  store.users.set(REQUESTER, {
    id: REQUESTER,
    email: 'requester@example.com',
    name: '山田 太郎',
    passwordHash: 'x',
    role: 'requester',
    tenantId: TENANT,
    createdAt: now,
    updatedAt: now,
  });
}

// JSON ボディでチケット作成リクエストを組み立てる
function buildJsonRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
  // fetch は常にモックし、成功レスポンスを返す (Slack Adapter が呼ぶ)
  fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('ok') });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/tickets (外部通知)', () => {
  it('Slack Webhook 設定済みテナントで起票すると Slack へ通知される', async () => {
    await seedTenant(SLACK_WEBHOOK_URL);
    const { POST } = await import('@/app/api/tickets/route');

    const res = await POST(
      buildJsonRequest({
        title: '複合機が印刷できない',
        body: '朝から紙詰まりが続く',
        priority: 'Medium',
      }),
    );

    // チケット作成自体は成功する
    expect(res.status).toBe(201);
    // Slack Webhook へ 1 回だけ POST される
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SLACK_WEBHOOK_URL);
    // 通知本文にチケット件名が含まれる
    const payload = JSON.parse(init.body);
    const texts = JSON.stringify(payload);
    expect(texts).toContain('複合機が印刷できない');
  });

  it('外部通知が未設定のテナントで起票しても fetch は呼ばれない', async () => {
    await seedTenant(null);
    const { POST } = await import('@/app/api/tickets/route');

    const res = await POST(
      buildJsonRequest({
        title: 'PC が起動しない',
        body: '電源ボタンを押しても反応なし',
        priority: 'High',
      }),
    );

    expect(res.status).toBe(201);
    // 通知チャネルが 1 つも設定されていないため fetch は呼ばれない
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('外部通知の送信失敗はチケット作成のレスポンスに影響しない', async () => {
    await seedTenant(SLACK_WEBHOOK_URL);
    // Slack への送信を失敗させる (ネットワークエラーを模擬)
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { POST } = await import('@/app/api/tickets/route');

    const res = await POST(
      buildJsonRequest({
        title: 'ネットワークに繋がらない',
        body: 'Wi-Fi が切れる',
        priority: 'Low',
      }),
    );

    // Slack 送信が失敗してもチケット作成は 201 で成功する (ベストエフォート)
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.title).toBe('ネットワークに繋がらない');
  });
});
