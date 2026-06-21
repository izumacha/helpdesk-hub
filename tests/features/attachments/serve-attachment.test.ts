// GET /api/attachments/[id] の認可テスト。
// 主検証:
//   1. 未認証 → 401
//   2. 同テナント + 自分のチケット → 200 + バイト列
//   3. 別テナント → 404 (存在を隠す)
//   4. 同テナント別ユーザー (requester) → 404
//   5. エージェントは同テナント全てのチケット添付を閲覧可能 → 200
//   6. 物理ファイル消失 → 404

// Vitest の DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ context (store/repos/uow) と メモリストレージ
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import { createMemoryStorage, type MemoryStoragePort } from '@/data/adapters/memory/storage.memory';
// 型のみ
import type { Repos } from '@/data/ports/unit-of-work';
import type { Session } from 'next-auth';

// 使うテナント / ユーザー
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const REQ_A = 'u-req-a';
const REQ_A2 = 'u-req-a2';
const AGENT_A = 'u-agt-a';
const REQ_B = 'u-req-b';

// テスト中に差し替えるセッション (auth() のモック戻り値)
let mockSession: Session | null;
// メモリの可変な依存
let store: Store;
let repos: Repos;
let storage: MemoryStoragePort;

// @/data モジュールを差し替え (getter で参照することで beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// storage は別モジュールから export されているため別途モックする
vi.mock('@/data/storage', () => ({
  get storage() {
    return storage;
  },
}));

// セッションはテストごとに差し替える
vi.mock('@/lib/auth', () => ({
  auth: async () => mockSession,
}));

// 1 テナントに requester 2 名 + agent 1 名、別テナントに requester 1 名と、
// それぞれにチケット + 添付を 1 件ずつ用意する
async function seed() {
  const now = new Date();
  // テナント A・B を投入
  for (const t of [TENANT_A, TENANT_B]) {
    store.tenants.set(t, { id: t, name: t, mode: 'lite', industry: null, inboundToken: null, slackWebhookUrl: null, subscriptionPlan: 'free' as const, stripeCustomerId: null, stripeSubscriptionId: null, stripeSubscriptionStatus: null, createdAt: now });
  }
  // ユーザーを投入する
  const users: Array<[string, 'requester' | 'agent', string]> = [
    [REQ_A, 'requester', TENANT_A],
    [REQ_A2, 'requester', TENANT_A],
    [AGENT_A, 'agent', TENANT_A],
    [REQ_B, 'requester', TENANT_B],
  ];
  for (const [id, role, tenantId] of users) {
    store.users.set(id, {
      id,
      email: `${id}@example.com`,
      name: id,
      passwordHash: 'x',
      role,
      tenantId,
      createdAt: now,
      updatedAt: now,
    });
  }
  // テナント A: REQ_A が起票したチケットに添付 1 件
  const ticketA = await repos.tickets.create({
    title: 'A',
    body: 'a',
    priority: 'Medium',
    categoryId: null,
    creatorId: REQ_A,
    tenantId: TENANT_A,
  });
  const keyA = `${TENANT_A}/${ticketA.id}/aaa.jpg`;
  await storage.put(keyA, new Uint8Array([1, 2, 3]), {
    contentType: 'image/jpeg',
    size: 3,
  });
  const attA = await repos.attachments.create({
    ticketId: ticketA.id,
    commentId: null,
    uploaderId: REQ_A,
    tenantId: TENANT_A,
    mimeType: 'image/jpeg',
    size: 3,
    originalName: 'a.jpg',
    storageKey: keyA,
    storage: 'local',
  });
  // テナント B: REQ_B が起票したチケットに添付 1 件
  const ticketB = await repos.tickets.create({
    title: 'B',
    body: 'b',
    priority: 'Medium',
    categoryId: null,
    creatorId: REQ_B,
    tenantId: TENANT_B,
  });
  const keyB = `${TENANT_B}/${ticketB.id}/bbb.jpg`;
  await storage.put(keyB, new Uint8Array([4, 5, 6]), {
    contentType: 'image/jpeg',
    size: 3,
  });
  const attB = await repos.attachments.create({
    ticketId: ticketB.id,
    commentId: null,
    uploaderId: REQ_B,
    tenantId: TENANT_B,
    mimeType: 'image/jpeg',
    size: 3,
    originalName: 'b.jpg',
    storageKey: keyB,
    storage: 'local',
  });
  return { attA, attB };
}

// テスト中に渡す Request (URL は固定で OK、動的セグメントは params で渡す)
function buildRequest(): Request {
  return new Request('http://localhost/api/attachments/x', { method: 'GET' });
}

// 動的セグメント params の Promise を作るヘルパー
function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

// テスト中に使う最低限のセッション形状を組み立てる
function buildSession(userId: string, role: 'requester' | 'agent', tenantId: string): Session {
  return {
    user: { id: userId, role, tenantId },
    expires: new Date(Date.now() + 86_400_000).toISOString(),
  } as Session;
}

beforeEach(() => {
  // 各テストで独立な context / storage / セッションに戻す
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  storage = createMemoryStorage();
  mockSession = null;
  vi.resetModules();
});

describe('GET /api/attachments/[id]', () => {
  // 未認証 → 401
  it('returns 401 when no session', async () => {
    const { attA } = await seed();
    const { GET } = await import('@/app/api/attachments/[id]/route');
    mockSession = null;
    const res = await GET(buildRequest(), makeParams(attA.id));
    expect(res.status).toBe(401);
  });

  // 同テナント + 自分のチケット → 200 + バイト列
  it('returns the bytes when the requester owns the parent ticket', async () => {
    const { attA } = await seed();
    mockSession = buildSession(REQ_A, 'requester', TENANT_A);
    const { GET } = await import('@/app/api/attachments/[id]/route');
    const res = await GET(buildRequest(), makeParams(attA.id));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    // バイト列が一致する
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf).toEqual(new Uint8Array([1, 2, 3]));
  });

  // 別テナント → 404
  it('returns 404 for a cross-tenant attachment id', async () => {
    const { attB } = await seed();
    // テナント A のユーザーが テナント B の添付 ID を叩く
    mockSession = buildSession(REQ_A, 'requester', TENANT_A);
    const { GET } = await import('@/app/api/attachments/[id]/route');
    const res = await GET(buildRequest(), makeParams(attB.id));
    expect(res.status).toBe(404);
  });

  // 同テナント別ユーザー (requester) → 404 (チケット閲覧権限なし)
  it('returns 404 when a requester tries to view another user\'s ticket attachment', async () => {
    const { attA } = await seed();
    // 同テナント内の別 requester (REQ_A2) が REQ_A のチケットの添付を要求
    mockSession = buildSession(REQ_A2, 'requester', TENANT_A);
    const { GET } = await import('@/app/api/attachments/[id]/route');
    const res = await GET(buildRequest(), makeParams(attA.id));
    expect(res.status).toBe(404);
  });

  // エージェントは同テナント全てのチケット添付を見られる → 200
  it('allows an agent to view any same-tenant ticket attachment', async () => {
    const { attA } = await seed();
    mockSession = buildSession(AGENT_A, 'agent', TENANT_A);
    const { GET } = await import('@/app/api/attachments/[id]/route');
    const res = await GET(buildRequest(), makeParams(attA.id));
    expect(res.status).toBe(200);
  });

  // ストレージ上のファイルが消えている → 404
  it('returns 404 when the physical file is missing', async () => {
    const { attA } = await seed();
    mockSession = buildSession(REQ_A, 'requester', TENANT_A);
    // ストレージから物理ファイルだけ削除する
    await storage.delete(attA.storageKey);
    const { GET } = await import('@/app/api/attachments/[id]/route');
    const res = await GET(buildRequest(), makeParams(attA.id));
    expect(res.status).toBe(404);
  });
});
