// POST /api/tickets を multipart で叩いて添付ファイルがチケットと一緒に保存されることを検証する。
// 主検証:
//   1. 正常系: 添付 2 件 → 201 + Attachment 行 2 件 + storage に 2 件のバイト列
//   2. 異常系 (MIME 違反): 422 + チケットが作成されない
//   3. ロールバック: 2 件目の DB INSERT で失敗 → DB はチケットも添付も残らない + storage も空

// Vitest の DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos/uow)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// メモリストレージ (テスト内のファイル I/O 用)
import { createMemoryStorage, type MemoryStoragePort } from '@/data/adapters/memory/storage.memory';
// 型のみ
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';

// 主に使うテナント ID (Lite モード) と依頼者 ID
const TENANT = 'default-tenant';
const REQUESTER = 'u-req-1';

// 各テストで差し替える可変な依存 (Action import 前に値を入れる)
let store: Store;
let repos: Repos;
let uow: UnitOfWork;
let storage: MemoryStoragePort;

// @/data モジュールを差し替え (getter で参照することで beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
  get uow() {
    return uow;
  },
}));

// storage は別モジュールから export されているため別途モックする
vi.mock('@/data/storage', () => ({
  get storage() {
    return storage;
  },
}));

// セッションは依頼者で固定 (テナント Lite モードで起票する)
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: REQUESTER, role: 'requester' as const, tenantId: TENANT },
  }),
}));

// 共通シード: テナント (Lite モード) + 依頼者 1 人
async function seed() {
  const now = new Date();
  // Lite モードのテナントを投入
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode: 'lite',
    industry: null,
    inboundToken: null, // メール取り込み未発行 (テスト用フィクスチャ)
      slackWebhookUrl: null, subscriptionPlan: 'free' as const, stripeCustomerId: null, stripeSubscriptionId: null, stripeSubscriptionStatus: null, teamsWebhookUrl: null, chatworkApiToken: null, chatworkRoomId: null, // Slack 通知未設定 (テスト用フィクスチャ)
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

// 既知のマジックバイト (validateUploadedFiles の整合チェックを通すため必要)
const MAGIC: Record<string, Uint8Array> = {
  'image/jpeg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
  'image/png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};

// File を作るヘルパー (申告 MIME に対応するマジックバイトを先頭に置き、その後にテキスト本体を続ける)
// MIME がマジック未登録ならそのままテキストを返す (拒否ケースのテストで使う)
function makeFile(name: string, type: string, body: string): File {
  const magic = MAGIC[type];
  const text = new TextEncoder().encode(body);
  // マジックがあれば連結、無ければテキストだけで File を作る
  const data = magic ? new Uint8Array([...magic, ...text]) : text;
  return new File([data], name, { type });
}

// multipart/form-data リクエストを組み立てて Request 化する
function buildMultipartRequest(fields: Record<string, string>, files: File[]): Request {
  // FormData を組み立てる
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files) form.append('files', f, f.name);
  // Request にして POST する (Node 環境では undici が multipart の境界を自動で組み立てる)
  return new Request('http://localhost/api/tickets', { method: 'POST', body: form });
}

beforeEach(async () => {
  // 毎回新しい context / storage を作って独立な状態にする
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  uow = ctx.uow;
  storage = createMemoryStorage();
  // 動的 import の結果をリセット (mock 設定を反映させるため)
  vi.resetModules();
  // 共通シードを毎回投入
  await seed();
});

describe('POST /api/tickets (multipart with attachments)', () => {
  // Content-Type の大文字小文字を問わず multipart と判定される (Codex 指摘対応)
  it('detects multipart even when the Content-Type is mixed case', async () => {
    const { POST } = await import('@/app/api/tickets/route');
    // まず通常の FormData リクエストを作り、自動付与された boundary 付き Content-Type を取り出す
    const base = buildMultipartRequest({ title: 'T', body: 'b', priority: 'Medium' }, [
      makeFile('a.jpg', 'image/jpeg', 'jpeg-bytes'),
    ]);
    const autoType = base.headers.get('content-type') ?? '';
    const bodyBuf = await base.arrayBuffer();
    // メディアタイプ部分だけ大文字化する (boundary パラメータは温存)
    const upperType = autoType.replace('multipart/form-data', 'Multipart/Form-Data');
    // 大文字化した Content-Type で同じボディを再構築する
    const req = new Request('http://localhost/api/tickets', {
      method: 'POST',
      headers: { 'content-type': upperType },
      body: bodyBuf,
    });

    const res = await POST(req);
    // multipart として認識され、JSON パス (400) に落ちず 201 で作成される
    expect(res.status).toBe(201);
    const ticket = await res.json();
    const attachments = await repos.attachments.listByTicket(ticket.id, TENANT);
    expect(attachments).toHaveLength(1);
  });

  // 正常系: 添付 2 件付きでチケットが作成され、storage と DB に正しく書き込まれる
  it('creates a ticket and saves all attachments to storage + DB', async () => {
    // 動的 import (mock 適用後)
    const { POST } = await import('@/app/api/tickets/route');

    // 2 件の画像 (JPEG / PNG) を multipart で送る
    const req = buildMultipartRequest(
      {
        title: 'プリンタが動かない',
        body: '紙詰まりエラーが出る',
        priority: 'Medium',
      },
      [
        makeFile('a.jpg', 'image/jpeg', 'jpeg-bytes'),
        makeFile('b.png', 'image/png', 'png-bytes'),
      ],
    );

    // POST 実行
    const res = await POST(req);
    expect(res.status).toBe(201);
    // 作成されたチケットを返り値で確認
    const ticket = await res.json();
    expect(ticket.title).toBe('プリンタが動かない');

    // DB に添付が 2 件保存されている
    const attachments = await repos.attachments.listByTicket(ticket.id, TENANT);
    expect(attachments).toHaveLength(2);
    // ストレージにも 2 ファイル書き込まれている (順序保証は無いがキーがチケット ID 配下)
    expect(storage.entries.size).toBe(2);
    for (const a of attachments) {
      expect(a.storageKey.startsWith(`${TENANT}/${ticket.id}/`)).toBe(true);
      expect(storage.entries.has(a.storageKey)).toBe(true);
    }
  });

  // 異常系: PDF (許可外 MIME) を送ると 422 でチケットも添付も作成されない
  it('rejects disallowed MIME and creates nothing', async () => {
    const { POST } = await import('@/app/api/tickets/route');

    const req = buildMultipartRequest(
      { title: 't', body: 'b', priority: 'Medium' },
      [makeFile('doc.pdf', 'application/pdf', 'pdf-bytes')],
    );

    const res = await POST(req);
    expect(res.status).toBe(422);
    // チケットも添付も作成されていない (store が空のまま)
    expect(store.tickets.size).toBe(0);
    expect(store.attachments.size).toBe(0);
    expect(storage.entries.size).toBe(0);
  });

  // ロールバック: storage への 2 件目の書き込みで失敗 → DB は空 + 1 件目の書き込みも削除される
  // (実運用では「ディスクフル / S3 障害」が発生し得る。メモリ UoW のロールバックと
  //  クリーンアップ処理が連携することを回帰として検証する)
  it('rolls back DB and cleans up storage when storage.put fails midway', async () => {
    // storage.put を 2 回目の呼び出しで例外を投げるよう差し替える
    const originalPut = storage.put.bind(storage);
    let callCount = 0;
    storage.put = vi.fn(async (key, data, meta) => {
      callCount += 1;
      if (callCount === 2) throw new Error('synthetic disk full');
      return originalPut(key, data, meta);
    });

    const { POST } = await import('@/app/api/tickets/route');
    const req = buildMultipartRequest(
      { title: 't', body: 'b', priority: 'Medium' },
      [
        makeFile('a.jpg', 'image/jpeg', 'jpeg-a'),
        makeFile('b.jpg', 'image/jpeg', 'jpeg-b'),
      ],
    );

    const res = await POST(req);
    // 500 で失敗を伝える
    expect(res.status).toBe(500);
    // メモリ UoW がロールバックしてくれるので、チケットも添付も DB に残らない
    expect(store.tickets.size).toBe(0);
    expect(store.attachments.size).toBe(0);
    // storage に書き込んだ 1 件目もクリーンアップで全削除されている
    expect(storage.entries.size).toBe(0);
  });

  // 件数超過: 6 件送ると 422 で何も作成されない
  it('rejects more than 5 attachments', async () => {
    const { POST } = await import('@/app/api/tickets/route');
    const files = Array.from({ length: 6 }, (_, i) =>
      makeFile(`a${i}.jpg`, 'image/jpeg', `jpeg-${i}`),
    );
    const req = buildMultipartRequest(
      { title: 't', body: 'b', priority: 'Medium' },
      files,
    );

    const res = await POST(req);
    expect(res.status).toBe(422);
    expect(store.tickets.size).toBe(0);
    expect(storage.entries.size).toBe(0);
  });
});
