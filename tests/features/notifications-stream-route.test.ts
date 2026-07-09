// GET /api/notifications/stream (SSE) のテスト。
// 監査で発見したギャップ対応: ユーザー単位で新規接続確立にレート制限を追加したことを検証する。
// 主検証:
//   1. 未認証 → 401
//   2. 上限を超えた新規接続は 429 + Retry-After
//   3. 別ユーザーの接続は独立してカウントされる (巻き込まれない)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import { createInMemoryNotificationBroadcaster } from '@/data/adapters/memory/notification-broadcaster.memory';
import type { Repos } from '@/data/ports/unit-of-work';
import type { NotificationBroadcaster } from '@/data/ports/notification-broadcaster';
import type { Session } from 'next-auth';

const TENANT = 'default-tenant';
const REQUESTER_A = 'u-req-a';
const REQUESTER_B = 'u-req-b';

let store: Store;
let repos: Repos;
let notificationBroadcaster: NotificationBroadcaster;
let mockSession: Session | null;

vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
  get notificationBroadcaster() {
    return notificationBroadcaster;
  },
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => mockSession,
}));

function buildSession(userId: string): Session {
  return {
    user: { id: userId, role: 'requester', tenantId: TENANT },
    expires: new Date(Date.now() + 86_400_000).toISOString(),
  } as Session;
}

// レスポンスのストリームを即座に解放するヘルパー (keep-alive の setInterval を止め、
// 購読者 Map から登録解除させることでテスト間のリソースリークを防ぐ)
async function closeStream(res: Response): Promise<void> {
  await res.body?.cancel();
}

beforeEach(async () => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  notificationBroadcaster = createInMemoryNotificationBroadcaster();
  mockSession = null;
  vi.resetModules();
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode: 'lite',
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    subscriptionPlan: 'free',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    createdAt: new Date(),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/notifications/stream', () => {
  // 未認証 → 401
  it('returns 401 when no session', async () => {
    mockSession = null;
    const { GET } = await import('@/app/api/notifications/stream/route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  // 監査で発見したギャップ対応: ユーザー単位で 60 秒あたり 60 回を超える新規接続は 429 になる
  it('returns 429 with Retry-After once the per-user connect rate limit is exceeded', async () => {
    mockSession = buildSession(REQUESTER_A);
    const { GET } = await import('@/app/api/notifications/stream/route');
    // 上限 (60回) までは通常どおり 200 を返す
    for (let i = 0; i < 60; i++) {
      const res = await GET();
      expect(res.status).toBe(200);
      await closeStream(res);
    }
    // 61 回目は 429 になる
    const res = await GET();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toEqual(expect.any(String));
  });

  // 分離: 別ユーザーの接続は独立してカウントされる (他人の連打で自分が巻き込まれない)
  it('tracks the rate limit independently per user', async () => {
    const { GET } = await import('@/app/api/notifications/stream/route');
    // REQUESTER_A が上限まで接続する
    mockSession = buildSession(REQUESTER_A);
    for (let i = 0; i < 60; i++) {
      const res = await GET();
      await closeStream(res);
    }
    const overLimitRes = await GET();
    expect(overLimitRes.status).toBe(429);
    // REQUESTER_B はまだ接続していないので 200 のまま
    mockSession = buildSession(REQUESTER_B);
    const res = await GET();
    expect(res.status).toBe(200);
    await closeStream(res);
  });
});
