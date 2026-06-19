// POST /api/inbound/email (Phase 2 メール取り込み) の Route Handler テスト。
// シークレット検証 / テナント特定 / 送信者検証 (隔離) / Lite 起票の挙動を、
// メモリアダプタと環境変数スタブで検証する (DB を持ち込まない)。

// Vitest の DSL とモック機能
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// 型のみ
import type { Repos } from '@/data/ports/unit-of-work';

// テスト用の固定値
const SECRET = 'test-inbound-secret';
const TENANT = 'default-tenant';
const TOKEN = 'abc123';
const MEMBER_EMAIL = 'ichiro@example.com';
const MEMBER_ID = 'u-member-1';

// 各テストで差し替える可変な依存 (Route import 前に値を入れる)
let store: Store;
let repos: Repos;

// @/data を差し替え (getter で beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// テナント (Lite) + 既知メンバー 1 人をシードする
function seed() {
  const now = new Date();
  // 取り込みトークンを持つ Lite テナント
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode: 'lite',
    industry: null,
    inboundToken: TOKEN,
    createdAt: now,
  });
  // テナント所属の既知メンバー (送信者として許可される)
  store.users.set(MEMBER_ID, {
    id: MEMBER_ID,
    email: MEMBER_EMAIL,
    name: '鈴木 一郎',
    passwordHash: 'x',
    role: 'requester',
    tenantId: TENANT,
    createdAt: now,
    updatedAt: now,
  });
}

// JSON ボディ + シークレットヘッダ付きの Request を組み立てる小ヘルパー
function makeRequest(body: Record<string, unknown>, opts?: { secret?: string | null }): Request {
  // ヘッダを組み立てる (secret 指定が null のときはヘッダを付けない)
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const secret = opts && 'secret' in opts ? opts.secret : SECRET;
  if (secret) headers['x-inbound-secret'] = secret;
  // フル URL を渡す (Route 内で new URL(req.url) するため)
  return new Request('http://localhost/api/inbound/email', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// 正常系で使う受信メール本体
const VALID_EMAIL = {
  to: `${TOKEN}@inbox.helpdesk-hub.app`,
  from: '鈴木 一郎 <ichiro@example.com>',
  subject: 'プリンターが動きません',
  text: '3階のプリンターが反応しません。',
};

describe('POST /api/inbound/email', () => {
  // 各テストでメモリ context を作り直し、シークレット環境変数をセットする
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    seed();
    vi.stubEnv('INBOUND_EMAIL_SECRET', SECRET);
  });

  // 環境変数スタブを毎回戻す
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // 正常系: 既知メンバーからのメールが Lite テナントで 'Open' 起票される
  it('既知メンバーのメールを Open ステータスで起票する', async () => {
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest(VALID_EMAIL));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ticketId: string };
    // 返ってきた ID のチケットがストアに存在し、Lite の起点 'Open' になっている
    const ticket = store.tickets.get(json.ticketId);
    expect(ticket).toBeTruthy();
    expect(ticket?.status).toBe('Open');
    expect(ticket?.title).toBe('プリンターが動きません');
    expect(ticket?.creatorId).toBe(MEMBER_ID);
    expect(ticket?.tenantId).toBe(TENANT);
  });

  // シークレット未設定 (env なし) なら fail-closed で 500
  it('シークレット未設定なら 500 を返す', async () => {
    vi.stubEnv('INBOUND_EMAIL_SECRET', '');
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest(VALID_EMAIL));
    expect(res.status).toBe(500);
  });

  // 誤ったシークレットは 401
  it('誤ったシークレットは 401 を返す', async () => {
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest(VALID_EMAIL, { secret: 'wrong' }));
    expect(res.status).toBe(401);
    // 起票されていないこと
    expect(store.tickets.size).toBe(0);
  });

  // シークレット未提示も 401
  it('シークレット未提示は 401 を返す', async () => {
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest(VALID_EMAIL, { secret: null }));
    expect(res.status).toBe(401);
  });

  // 存在しないトークン宛は 404
  it('未知の宛先トークンは 404 を返す', async () => {
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest({ ...VALID_EMAIL, to: 'nope@inbox.helpdesk-hub.app' }));
    expect(res.status).toBe(404);
    expect(store.tickets.size).toBe(0);
  });

  // テナント外 (未知) の送信者は隔離 = 202 で起票しない
  it('未知の送信者は隔離して 202 を返す', async () => {
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest({ ...VALID_EMAIL, from: 'stranger@example.com' }));
    expect(res.status).toBe(202);
    expect(store.tickets.size).toBe(0);
  });

  // 他テナント所属ユーザーからの送信もクロステナント防止で隔離する
  it('他テナント所属の送信者は隔離する', async () => {
    // 別テナントに同名でない別ユーザーを置く
    const now = new Date();
    store.tenants.set('other', {
      id: 'other',
      name: '別組織',
      mode: 'lite',
      industry: null,
      inboundToken: 'other-token',
      createdAt: now,
    });
    store.users.set('u-other', {
      id: 'u-other',
      email: 'outsider@example.com',
      name: '部外者',
      passwordHash: 'x',
      role: 'requester',
      tenantId: 'other',
      createdAt: now,
      updatedAt: now,
    });
    const { POST } = await import('@/app/api/inbound/email/route');
    // outsider は other テナント所属だが、宛先トークンは default-tenant 宛
    const res = await POST(makeRequest({ ...VALID_EMAIL, from: 'outsider@example.com' }));
    expect(res.status).toBe(202);
    expect(store.tickets.size).toBe(0);
  });

  // 送信者アドレスが壊れている場合は 422 (起票不能)
  it('送信者アドレスが不正なら 422 を返す', async () => {
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest({ ...VALID_EMAIL, from: 'broken-address' }));
    expect(res.status).toBe(422);
    expect(store.tickets.size).toBe(0);
  });
});
