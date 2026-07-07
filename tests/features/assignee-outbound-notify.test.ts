// updateTicketAssignee が Slack/Teams/Chatwork 外部通知 (sendOutboundNotification) を送ることを検証する。
// 従来はステータス変更 (updateTicketStatus) とエスカレーション (escalateTicket) にしか
// 外部通知が配線されておらず、同格に重要な「担当者が割り当てられた」イベントだけが
// チーム共有チャネルに届かない不整合があった。
// 主検証:
//   1. Slack Webhook 設定済みテナントで担当者を割り当てると fetch が 1 回呼ばれる
//   2. 担当解除 (null) では外部通知を送らない (注意を引く必要が薄いイベントのため対象外)
//   3. 外部通知未設定テナントで割り当てても fetch は呼ばれない (無駄打ちしない)

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
const NEW_ASSIGNEE = 'u-agt-2';
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

// セッションはエージェントで固定 (担当者割当はエージェント以上のみ実行可)
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

// 担当者割当メール送信 (別経路) はテストの主眼ではないため no-op にする
vi.mock('@/lib/email', () => ({
  getEmailSender: () => ({ send: async () => {} }),
}));

// テナント + 操作者エージェント + 割当候補エージェント + チケットを 1 件投入するヘルパー。
// slackWebhookUrl だけを差し替えられるようにする
async function seed(slackWebhookUrl: string | null): Promise<{ ticketId: string }> {
  const now = new Date();
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
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    createdAt: now,
  });
  // 操作者エージェント
  store.users.set(AGENT, {
    id: AGENT,
    email: 'agent1@example.com',
    name: '操作担当者',
    passwordHash: 'x',
    role: 'agent',
    tenantId: TENANT,
    createdAt: now,
    updatedAt: now,
  });
  // 割当先候補の別エージェント
  store.users.set(NEW_ASSIGNEE, {
    id: NEW_ASSIGNEE,
    email: 'agent2@example.com',
    name: '新担当者',
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
  // 検証対象チケットを作成する (未割当)
  const ticket = await repos.tickets.create({
    title: 'プリンタが動かない',
    body: '朝から紙詰まりが続く',
    priority: 'Medium',
    creatorId: 'u-req-1',
    categoryId: null,
    tenantId: TENANT,
  });
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

describe('updateTicketAssignee (外部通知)', () => {
  it('Slack Webhook 設定済みテナントで担当者を割り当てると Slack へ通知される', async () => {
    const { ticketId } = await seed(SLACK_WEBHOOK_URL);
    const { updateTicketAssignee } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketAssignee(ticketId, NEW_ASSIGNEE);

    // 割当自体は成功する
    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.assigneeId).toBe(NEW_ASSIGNEE);
    // Slack Webhook へ 1 回だけ POST される
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SLACK_WEBHOOK_URL);
    const texts = JSON.stringify(JSON.parse(init.body));
    expect(texts).toContain('プリンタが動かない');
    expect(texts).toContain('新担当者');
  });

  it('担当解除 (null) では外部通知を送らない', async () => {
    const { ticketId } = await seed(SLACK_WEBHOOK_URL);
    const { updateTicketAssignee } = await import('@/features/tickets/actions/update-ticket');
    // 先に割り当ててから解除する
    await updateTicketAssignee(ticketId, NEW_ASSIGNEE);
    fetchMock.mockClear();

    await updateTicketAssignee(ticketId, null);

    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.assigneeId).toBeNull();
    // 解除では外部通知を送らない
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('外部通知が未設定のテナントで割り当てても fetch は呼ばれない', async () => {
    const { ticketId } = await seed(null);
    const { updateTicketAssignee } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketAssignee(ticketId, NEW_ASSIGNEE);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
