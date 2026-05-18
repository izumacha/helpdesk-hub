// addCommentWithAttachments Server Action のユニットテスト。
// 主検証:
//   1. 本文 + 画像 1 枚を投稿 → コメント + 添付 (commentId 紐付け) が保存される
//   2. 別テナントのチケットを指定 → エラー (チケットが見つかりません)
//   3. 許可外 MIME → エラー
//   4. 1 件目の storage.put が失敗 → DB は空 + storage も空 (ロールバック)

// Vitest の DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ context (store/repos/uow)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// メモリストレージ
import { createMemoryStorage, type MemoryStoragePort } from '@/data/adapters/memory/storage.memory';
// 型のみ
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
// レート制限の履歴をテスト間でクリアする内部用関数
import { __resetRateLimits } from '@/lib/rate-limit';

// 主に使うテナント / ユーザー / チケット
const TENANT = 'default-tenant';
const REQUESTER = 'u-req-1';

// 可変な依存
let store: Store;
let repos: Repos;
let uow: UnitOfWork;
let storage: MemoryStoragePort;
let sessionUserId = REQUESTER;
let sessionRole: 'requester' | 'agent' = 'requester';

// @/data モジュールを差し替え
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
  get uow() {
    return uow;
  },
  get storage() {
    return storage;
  },
}));

// セッションを動的に切り替えるためのモック
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: sessionUserId, role: sessionRole, tenantId: TENANT },
  }),
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

// 1 テナント + 依頼者 + 担当者 + 1 チケットを投入する
async function seed() {
  const now = new Date();
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode: 'lite',
    industry: null,
    createdAt: now,
  });
  // 依頼者ユーザー
  store.users.set(REQUESTER, {
    id: REQUESTER,
    email: 'req@example.com',
    name: '山田',
    passwordHash: 'x',
    role: 'requester',
    tenantId: TENANT,
    createdAt: now,
    updatedAt: now,
  });
  // テナント内に最低 1 名のエージェントが必要 (依頼者コメントの通知宛先のため)
  store.users.set('u-agt-1', {
    id: 'u-agt-1',
    email: 'agt@example.com',
    name: '佐藤',
    passwordHash: 'x',
    role: 'agent',
    tenantId: TENANT,
    createdAt: now,
    updatedAt: now,
  });
  // 依頼者本人が起票したチケットを 1 件作成 (REQUESTER 自身がコメント可能)
  const ticket = await repos.tickets.create({
    title: 'プリンタが動かない',
    body: '紙詰まり',
    priority: 'Medium',
    creatorId: REQUESTER,
    categoryId: null,
    tenantId: TENANT,
  });
  return { ticketId: ticket.id };
}

// File を作るヘルパー
function makeFile(name: string, type: string, body: string): File {
  return new File([new TextEncoder().encode(body)], name, { type });
}

// FormData を組み立てる小さなヘルパー
function buildFormData(body: string, files: File[]): FormData {
  const fd = new FormData();
  fd.set('body', body);
  for (const f of files) fd.append('files', f, f.name);
  return fd;
}

beforeEach(() => {
  // 毎回独立な context + storage + 初期セッションに戻す
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  uow = ctx.uow;
  storage = createMemoryStorage();
  sessionUserId = REQUESTER;
  sessionRole = 'requester';
  vi.resetModules();
  __resetRateLimits();
});

describe('addCommentWithAttachments', () => {
  // 正常系: 本文 + 画像 1 枚 → コメント 1 件 + 添付 1 件 (commentId 紐付け)
  it('saves the comment and links the attachment via commentId', async () => {
    const { ticketId } = await seed();
    const { addCommentWithAttachments } = await import(
      '@/features/tickets/actions/add-comment-with-attachments'
    );
    const fd = buildFormData('追加で撮った写真です', [
      makeFile('p.jpg', 'image/jpeg', 'jpeg-data'),
    ]);

    await addCommentWithAttachments(ticketId, fd);

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

  // 異常系: 別テナントのチケット ID では「チケットが見つかりません」
  it('rejects when the ticket is in a different tenant', async () => {
    await seed();
    // 別テナント B にチケットを作って、テナント A のセッションから ID を指定する
    const otherTenant = 'tenant-b';
    store.tenants.set(otherTenant, {
      id: otherTenant,
      name: 'B',
      mode: 'lite',
      industry: null,
      createdAt: new Date(),
    });
    store.users.set('u-b', {
      id: 'u-b',
      email: 'b@example.com',
      name: 'B',
      passwordHash: 'x',
      role: 'requester',
      tenantId: otherTenant,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const foreignTicket = await repos.tickets.create({
      title: 'T',
      body: 'b',
      priority: 'Medium',
      creatorId: 'u-b',
      categoryId: null,
      tenantId: otherTenant,
    });
    const { addCommentWithAttachments } = await import(
      '@/features/tickets/actions/add-comment-with-attachments'
    );
    const fd = buildFormData('text', []);
    // テナント A のセッションから B のチケット ID を指定すると見つからない扱い
    await expect(addCommentWithAttachments(foreignTicket.id, fd)).rejects.toThrow(/見つかりません/);
  });

  // 異常系: 許可外 MIME (PDF) を送ると検証で弾かれる
  it('rejects disallowed MIME types', async () => {
    const { ticketId } = await seed();
    const { addCommentWithAttachments } = await import(
      '@/features/tickets/actions/add-comment-with-attachments'
    );
    const fd = buildFormData('text', [makeFile('d.pdf', 'application/pdf', 'pdf')]);
    await expect(addCommentWithAttachments(ticketId, fd)).rejects.toThrow(/この形式のファイル/);
    // DB / storage は空のまま
    expect(store.comments.size).toBe(0);
    expect(store.attachments.size).toBe(0);
    expect(storage.entries.size).toBe(0);
  });

  // ロールバック: storage.put の 1 回目で失敗 → DB は空 + storage も空
  it('rolls back DB and storage when storage.put fails', async () => {
    const { ticketId } = await seed();
    // storage.put をいきなり例外で落とす
    storage.put = vi.fn(async () => {
      throw new Error('synthetic failure');
    });
    const { addCommentWithAttachments } = await import(
      '@/features/tickets/actions/add-comment-with-attachments'
    );
    const fd = buildFormData('text', [makeFile('p.jpg', 'image/jpeg', 'jpeg')]);
    await expect(addCommentWithAttachments(ticketId, fd)).rejects.toThrow();
    // DB は空にロールバックされている
    expect(store.comments.size).toBe(0);
    expect(store.attachments.size).toBe(0);
    // ストレージも空のまま
    expect(storage.entries.size).toBe(0);
  });
});
