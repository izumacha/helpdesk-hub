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
// LINE 連携済みを装うための正規形式ユーザー ID ('U' + 32 桁 16 進数)。依頼者の lineUserId として使う
const REQUESTER_LINE_USER_ID = `U${'a'.repeat(32)}`;

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
      teamsWebhookUrl: null,
      chatworkApiToken: null,
      chatworkRoomId: null,
      createdAt: now,
    });
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

// 既知のマジックバイト (validateUploadedFiles の整合チェックを通すため必要)
const MAGIC: Record<string, Uint8Array> = {
  'image/jpeg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
  'image/png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};

// File を作るヘルパー (申告 MIME に対応するマジックバイトを先頭に置き、その後にテキスト本体を続ける)
function makeFile(name: string, type: string, body: string): File {
  const magic = MAGIC[type];
  const text = new TextEncoder().encode(body);
  const data = magic ? new Uint8Array([...magic, ...text]) : text;
  return new File([data], name, { type });
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

  // レート制限超過は 429 + Retry-After を返す (500 にしない / Codex 指摘対応)
  it('returns 429 with Retry-After when the comment rate limit is exceeded', async () => {
    const { ticketId } = await seed();
    mockSession = buildSession(REQUESTER, 'requester', TENANT);
    const { POST } = await import('@/app/api/tickets/[id]/comments/route');
    // 上限は 60 秒あたり 20 件。21 回投稿して 21 回目で 429 になることを確認する
    let last: Response | undefined;
    for (let i = 0; i < 21; i += 1) {
      last = await POST(buildRequest(`コメント${i}`, []), makeParams(ticketId));
    }
    expect(last?.status).toBe(429);
    // Retry-After ヘッダが秒数 (数値文字列) で付与されている
    expect(Number(last?.headers.get('Retry-After'))).toBeGreaterThanOrEqual(0);
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

  // ─────────────────────────────────────────────
  // 通知ルート (誰に通知が飛ぶか) の仕様
  // 旧 addComment Server Action のテストから移植 (PR レビュー指摘 #4 への対応)
  // ─────────────────────────────────────────────

  // 依頼者がコメント、担当者ありなら担当者だけに通知
  it('notifies the assignee when a requester comments on an assigned ticket', async () => {
    const { ticketId } = await seed();
    // 担当者を割り当てておく
    await repos.tickets.updateAssignee(ticketId, AGENT, TENANT);
    mockSession = buildSession(REQUESTER, 'requester', TENANT);
    const { POST } = await import('@/app/api/tickets/[id]/comments/route');
    const res = await POST(buildRequest('追加情報です', []), makeParams(ticketId));
    expect(res.status).toBe(201);

    // 通知は担当者 1 名のみ
    const notifications = [...store.notifications.values()];
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe(AGENT);
    expect(notifications[0].type).toBe('commented');
    expect(notifications[0].ticketId).toBe(ticketId);
  });

  // 依頼者がコメント、担当者未定ならテナント内全エージェントに通知
  it('notifies every agent when a requester comments on an unassigned ticket', async () => {
    const { ticketId } = await seed();
    // テナント内に複数エージェントを追加
    const now = new Date();
    store.users.set('u-agt-2', {
      id: 'u-agt-2',
      email: 'agt2@example.com',
      name: '鈴木',
      passwordHash: 'x',
      role: 'agent',
      tenantId: TENANT,
      createdAt: now,
      updatedAt: now,
    });
    mockSession = buildSession(REQUESTER, 'requester', TENANT);
    const { POST } = await import('@/app/api/tickets/[id]/comments/route');
    const res = await POST(buildRequest('どうなってますか', []), makeParams(ticketId));
    expect(res.status).toBe(201);

    // 通知は全エージェントに届く
    const notifications = [...store.notifications.values()];
    expect(new Set(notifications.map((n) => n.userId))).toEqual(new Set([AGENT, 'u-agt-2']));
    for (const n of notifications) {
      expect(n.type).toBe('commented');
      expect(n.ticketId).toBe(ticketId);
    }
  });

  // エージェントがコメント、担当者未定なら依頼者にだけ通知
  it('notifies the ticket creator when an agent comments on an unassigned ticket', async () => {
    const { ticketId } = await seed();
    mockSession = buildSession(AGENT, 'agent', TENANT);
    const { POST } = await import('@/app/api/tickets/[id]/comments/route');
    const res = await POST(buildRequest('確認しました', []), makeParams(ticketId));
    expect(res.status).toBe(201);

    const notifications = [...store.notifications.values()];
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe(REQUESTER);
    expect(notifications[0].type).toBe('commented');
  });

  // エージェントがコメント、担当者ありなら依頼者と担当者の両方に通知
  it('notifies both creator and assignee when an agent comments on an assigned ticket', async () => {
    const { ticketId } = await seed();
    // 別エージェント (u-agt-2) を作って担当者に
    const now = new Date();
    store.users.set('u-agt-2', {
      id: 'u-agt-2',
      email: 'agt2@example.com',
      name: '鈴木',
      passwordHash: 'x',
      role: 'agent',
      tenantId: TENANT,
      createdAt: now,
      updatedAt: now,
    });
    await repos.tickets.updateAssignee(ticketId, 'u-agt-2', TENANT);
    // 投稿者は別エージェント (AGENT) で、依頼者 + 担当者の両方に通知が飛ぶ想定
    mockSession = buildSession(AGENT, 'agent', TENANT);
    const { POST } = await import('@/app/api/tickets/[id]/comments/route');
    const res = await POST(buildRequest('対応を引き継ぎます', []), makeParams(ticketId));
    expect(res.status).toBe(201);

    const notifications = [...store.notifications.values()];
    expect(new Set(notifications.map((n) => n.userId))).toEqual(new Set([REQUESTER, 'u-agt-2']));
    for (const n of notifications) {
      expect(n.type).toBe('commented');
    }
  });

  // 投稿者自身には通知しない (重複通知の防止)
  it('does not notify the commenter themselves', async () => {
    const { ticketId } = await seed();
    // 担当者と投稿者が同一 (AGENT)
    await repos.tickets.updateAssignee(ticketId, AGENT, TENANT);
    mockSession = buildSession(AGENT, 'agent', TENANT);
    const { POST } = await import('@/app/api/tickets/[id]/comments/route');
    const res = await POST(buildRequest('自分のコメント', []), makeParams(ticketId));
    expect(res.status).toBe(201);

    const notifications = [...store.notifications.values()];
    // 依頼者 1 名にだけ届く (投稿者 = AGENT は除外)
    expect(notifications.map((n) => n.userId)).toEqual([REQUESTER]);
  });

  // Phase 2「担当者の返信が LINE に返る」: LINE 連携済み (lineUserId 設定済み) の依頼者には、
  // メールに加えて LINE Messaging API への push も行われる。
  it('pushes a LINE message to a linked requester when an agent replies', async () => {
    const { ticketId } = await seed();
    // 依頼者を LINE 連携済みにする
    const requester = store.users.get(REQUESTER)!;
    store.users.set(REQUESTER, { ...requester, lineUserId: REQUESTER_LINE_USER_ID });

    // LINE push を有効化し、fetch をモックして実際の外部送信は行わない
    vi.stubEnv('LINE_CHANNEL_ACCESS_TOKEN', 'test-access-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        type: 'basic',
        text: () => Promise.resolve('{}'),
      });
    vi.stubGlobal('fetch', fetchMock);

    try {
      mockSession = buildSession(AGENT, 'agent', TENANT);
      const { POST } = await import('@/app/api/tickets/[id]/comments/route');
      const res = await POST(buildRequest('対応しました', []), makeParams(ticketId));
      expect(res.status).toBe(201);

      // LINE Messaging API へ 1 回 push されている
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.line.me/v2/bot/message/push');
      const body = JSON.parse(init.body);
      expect(body.to).toBe(REQUESTER_LINE_USER_ID);
      expect(body.messages[0].text).toContain('対応しました');
    } finally {
      // 他テストへ影響しないよう env / fetch のスタブを必ず元に戻す
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});
