// POST /api/tickets/[id]/comments のユニットテスト (multipart 経由のコメント + 添付投稿)。
// Server Action から Route Handler に移行した理由: Server Action の 1MB body 上限を回避するため。
// 主検証:
//   1. 本文 + 画像 1 枚 → コメント保存 + 添付 (commentId 紐付け) + バイト列が storage に書かれる
//   2. 別テナントのチケット ID → 404 (存在を隠す)
//   3. 同テナント別 requester がコメント投稿 → 404 (RBAC)
//   4. 許可外 MIME → 422
//   5. storage.put が失敗 → 500 + DB 空 + storage 空 (ロールバック)

// Vitest の DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ context (store/repos/uow)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// メモリストレージ (添付バイナリ用)
import { createMemoryStorage, type MemoryStoragePort } from '@/data/adapters/memory/storage.memory';
// 型のみ
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
import type { Session } from 'next-auth';
// レート制限の履歴をテスト間でクリアする内部用関数
import { __resetRateLimits } from '@/lib/rate-limit';

// 主に使うテナント / ユーザー
const TENANT = 'default-tenant';
const TENANT_B = 'tenant-b';
const REQUESTER = 'u-req-1';
const REQUESTER2 = 'u-req-2';
const AGENT = 'u-agt-1';

// 可変な依存
let store: Store;
let repos: Repos;
let uow: UnitOfWork;
let storage: MemoryStoragePort;
// セッションをテストごとに差し替えるためのモック対象
let mockSession: Session | null;

// @/data モジュールを差し替え
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
  get uow() {
    return uow;
  },
}));

// storage は別モジュール
vi.mock('@/data/storage', () => ({
  get storage() {
    return storage;
  },
}));

// セッションを動的に切り替えるためのモック
vi.mock('@/lib/auth', () => ({
  auth: async () => mockSession,
}));

// next/cache の副作用は不要
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

// SSE ブロードキャスト経路も不要
vi.mock('@/lib/sse-subscribers', () => ({
  broadcast: vi.fn(),
}));

// テナント (Lite) + 依頼者 / 担当者 + 別テナント + チケットを投入する共通シード
async function seed() {
  const now = new Date();
  // テナント A・B を投入 (Lite モード)
  for (const t of [TENANT, TENANT_B]) {
    store.tenants.set(t, { id: t, name: t, mode: 'lite', industry: null, createdAt: now });
  }
  // テナント A のユーザー: requester ×2 + agent ×1
  const users: Array<[string, 'requester' | 'agent', string]> = [
    [REQUESTER, 'requester', TENANT],
    [REQUESTER2, 'requester', TENANT],
    [AGENT, 'agent', TENANT],
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
  // REQUESTER 起票のチケット (テナント A)
  const ticket = await repos.tickets.create({
    title: 'プリンタ',
    body: '紙詰まり',
    priority: 'Medium',
    creatorId: REQUESTER,
    categoryId: null,
    tenantId: TENANT,
  });
  // テナント B のチケット (クロステナントテスト用に最低限のシード)
  store.users.set('u-b', {
    id: 'u-b',
    email: 'b@example.com',
    name: 'B',
    passwordHash: 'x',
    role: 'requester',
    tenantId: TENANT_B,
    createdAt: now,
    updatedAt: now,
  });
  const ticketB = await repos.tickets.create({
    title: 'B',
    body: 'b',
    priority: 'Medium',
    creatorId: 'u-b',
    categoryId: null,
    tenantId: TENANT_B,
  });
  return { ticketId: ticket.id, ticketB: ticketB.id };
}

// File を作るヘルパー
function makeFile(name: string, type: string, body: string): File {
  return new File([new TextEncoder().encode(body)], name, { type });
}

// multipart Request を組み立てるヘルパー (Content-Type は undici が自動付与する)
function buildRequest(body: string, files: File[]): Request {
  const form = new FormData();
  form.set('body', body);
  for (const f of files) form.append('files', f, f.name);
  return new Request('http://localhost/api/tickets/x/comments', { method: 'POST', body: form });
}

// 動的セグメント params の Promise を作るヘルパー
function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// 最低限のセッション形状を組み立てる
function buildSession(userId: string, role: 'requester' | 'agent', tenantId: string): Session {
  return {
    user: { id: userId, role, tenantId },
    expires: new Date(Date.now() + 86_400_000).toISOString(),
  } as Session;
}

beforeEach(() => {
  // 毎回独立な context + storage + 初期セッションに戻す
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  uow = ctx.uow;
  storage = createMemoryStorage();
  mockSession = null;
  vi.resetModules();
  __resetRateLimits();
});

describe('POST /api/tickets/[id]/comments', () => {
  // 未認証は 401
  it('returns 401 when no session', async () => {
    const { ticketId } = await seed();
    mockSession = null;
    const { POST } = await import('@/app/api/tickets/[id]/comments/route');
    const res = await POST(buildRequest('text', []), makeParams(ticketId));
    expect(res.status).toBe(401);
  });

  // 正常系: 本文 + 画像 1 枚 → コメント + 添付 + storage 書き込み
  it('saves the comment and links the attachment via commentId', async () => {
    const { ticketId } = await seed();
    mockSession = buildSession(REQUESTER, 'requester', TENANT);
    const { POST } = await import('@/app/api/tickets/[id]/comments/route');
    const res = await POST(
      buildRequest('追加で撮った写真です', [makeFile('p.jpg', 'image/jpeg', 'jpeg-data')]),
      makeParams(ticketId),
    );
    expect(res.status).toBe(201);

    // コメントが 1 件保存されている
    const comments = [...store.comments.values()].filter((c) => c.ticketId === ticketId);
    expect(comments).toHaveLength(1);
    // 添付が 1 件保存され、commentId がコメント ID と一致する
    const attachments = await repos.attachments.listByTicket(ticketId, TENANT);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].commentId).toBe(comments[0].id);
    // ストレージにバイト列も書き込まれている
    expect(storage.entries.size).toBe(1);
  });

  // 別テナントのチケット ID → 404 (存在を隠す)
  it('returns 404 for cross-tenant ticket ids', async () => {
    const { ticketB } = await seed();
    mockSession = buildSession(REQUESTER, 'requester', TENANT);
    const { POST } = await import('@/app/api/tickets/[id]/comments/route');
    const res = await POST(buildRequest('text', []), makeParams(ticketB));
    expect(res.status).toBe(404);
    expect(store.comments.size).toBe(0);
  });

  // 同テナント別 requester がコメント投稿 → 404 (RBAC)
  it('returns 404 when a non-owner requester tries to comment', async () => {
    const { ticketId } = await seed();
    mockSession = buildSession(REQUESTER2, 'requester', TENANT);
    const { POST } = await import('@/app/api/tickets/[id]/comments/route');
    const res = await POST(buildRequest('text', []), makeParams(ticketId));
    expect(res.status).toBe(404);
    expect(store.comments.size).toBe(0);
  });

  // 異常系: 許可外 MIME (PDF) を送ると 422 で何も保存されない
  it('rejects disallowed MIME types with 422', async () => {
    const { ticketId } = await seed();
    mockSession = buildSession(REQUESTER, 'requester', TENANT);
    const { POST } = await import('@/app/api/tickets/[id]/comments/route');
    const res = await POST(
      buildRequest('text', [makeFile('d.pdf', 'application/pdf', 'pdf')]),
      makeParams(ticketId),
    );
    expect(res.status).toBe(422);
    expect(store.comments.size).toBe(0);
    expect(store.attachments.size).toBe(0);
    expect(storage.entries.size).toBe(0);
  });

  // ロールバック: storage.put が即時失敗 → 500 + DB 空 + storage 空
  it('rolls back DB and cleans up storage when storage.put fails', async () => {
    const { ticketId } = await seed();
    mockSession = buildSession(REQUESTER, 'requester', TENANT);
    // storage.put を例外で落とす
    storage.put = vi.fn(async () => {
      throw new Error('synthetic failure');
    });
    const { POST } = await import('@/app/api/tickets/[id]/comments/route');
    const res = await POST(
      buildRequest('text', [makeFile('p.jpg', 'image/jpeg', 'jpeg')]),
      makeParams(ticketId),
    );
    expect(res.status).toBe(500);
    // DB は空にロールバックされている
    expect(store.comments.size).toBe(0);
    expect(store.attachments.size).toBe(0);
    // ストレージも空のまま
    expect(storage.entries.size).toBe(0);
  });

  // エージェントは他人が起票したチケットにもコメント可能 → 201
  it('allows agents to comment on any same-tenant ticket', async () => {
    const { ticketId } = await seed();
    mockSession = buildSession(AGENT, 'agent', TENANT);
    const { POST } = await import('@/app/api/tickets/[id]/comments/route');
    const res = await POST(buildRequest('対応します', []), makeParams(ticketId));
    expect(res.status).toBe(201);
    expect(store.comments.size).toBe(1);
  });
});
