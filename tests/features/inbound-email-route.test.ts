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

// UnitOfWork 型 (スレッド継続のコメント追記でトランザクションを使う)
import type { UnitOfWork } from '@/data/ports/unit-of-work';

// 各テストで差し替える可変な依存 (Route import 前に値を入れる)
let store: Store;
let repos: Repos;
let uow: UnitOfWork;

// @/data を差し替え (getter で beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
  get uow() {
    return uow;
  },
}));

// next/cache の副作用 (revalidatePath) はテストでは不要
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

// SSE ブロードキャスト経路もテストでは不要 (購読者がいないだけだが明示的に無効化)
vi.mock('@/lib/sse-subscribers', () => ({
  broadcast: vi.fn(),
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
    slackWebhookUrl: null, subscriptionPlan: 'free' as const, stripeCustomerId: null, stripeSubscriptionId: null, stripeSubscriptionStatus: null, // Slack 通知未設定 (テスト用フィクスチャ)
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
    uow = ctx.uow;
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
      slackWebhookUrl: null, subscriptionPlan: 'free' as const, stripeCustomerId: null, stripeSubscriptionId: null, stripeSubscriptionStatus: null, // Slack 通知未設定 (テスト用フィクスチャ)
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

  // multipart (SendGrid 形式): 宛先は envelope を優先、送信者はヘッダ From を優先する。
  // envelope.from を詐称 (MAIL FROM 偽装) してもヘッダ From の既知メンバーで起票されること。
  it('multipart で envelope.from を詐称してもヘッダ From で起票する', async () => {
    // FormData を組み立てる (Request が自動で multipart の content-type を付ける)
    const form = new FormData();
    // envelope: 宛先は正しいトークン、from は詐称アドレス
    form.set(
      'envelope',
      JSON.stringify({ to: [`${TOKEN}@inbox.helpdesk-hub.app`], from: 'spoofed@evil.com' }),
    );
    // ヘッダ from は既知メンバー (本人特定はこちらを優先する)
    form.set('from', '鈴木 一郎 <ichiro@example.com>');
    form.set('subject', 'マルチパート取り込み');
    form.set('text', '本文');
    const req = new Request('http://localhost/api/inbound/email', {
      method: 'POST',
      headers: { 'x-inbound-secret': SECRET },
      body: form,
    });
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(req);
    // 既知メンバー (ヘッダ From) で起票される。envelope の詐称 from は使われない
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ticketId: string };
    expect(store.tickets.get(json.ticketId)?.creatorId).toBe(MEMBER_ID);
  });

  // Content-Length が上限超過なら本体を読む前に 413 で弾く
  it('巨大なメール (Content-Length 超過) は 413 を返す', async () => {
    const req = new Request('http://localhost/api/inbound/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-inbound-secret': SECRET,
        // 上限 (25MB) を超える Content-Length を申告する
        'content-length': String(30 * 1024 * 1024),
      },
      body: JSON.stringify(VALID_EMAIL),
    });
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(store.tickets.size).toBe(0);
  });

  // スレッド継続: 参照 Message-ID が既存チケットに紐づくなら、新規起票せずコメント追記する
  it('In-Reply-To が既知 Message-ID に一致すると既存チケットへコメント追記する', async () => {
    const { POST } = await import('@/app/api/inbound/email/route');
    // まず通常の受信メール (Message-ID 付き) で 1 件起票する
    const res1 = await POST(makeRequest({ ...VALID_EMAIL, messageId: '<orig-1@example.com>' }));
    expect(res1.status).toBe(201);
    const { ticketId } = (await res1.json()) as { ticketId: string };
    // 起票直後はコメント 0 件
    expect(store.comments.size).toBe(0);

    // 同じ送信者が、その起票メールに返信する (In-Reply-To で元 Message-ID を参照)
    const res2 = await POST(
      makeRequest({
        ...VALID_EMAIL,
        subject: 'Re: プリンターが動きません',
        text: 'まだ直りません',
        messageId: '<reply-1@example.com>',
        inReplyTo: '<orig-1@example.com>',
      }),
    );
    // 200 + threaded フラグで「追記」されたことを示す
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { ticketId: string; threaded?: boolean };
    expect(body2.threaded).toBe(true);
    expect(body2.ticketId).toBe(ticketId);
    // 新規チケットは増えず (1 件のまま)、コメントが 1 件追記される
    expect(store.tickets.size).toBe(1);
    expect(store.comments.size).toBe(1);
    // 追記コメントは送信者本人 (既知メンバー) が作者で、本文が載る
    const comment = Array.from(store.comments.values())[0];
    expect(comment.ticketId).toBe(ticketId);
    expect(comment.authorId).toBe(MEMBER_ID);
    expect(comment.body).toBe('まだ直りません');
  });

  // スレッド継続: 同じ Message-ID の再送 (Webhook リトライ) は冪等で二重取り込みしない
  it('同一 Message-ID の再送は冪等に処理する (duplicate)', async () => {
    const { POST } = await import('@/app/api/inbound/email/route');
    const req = () => makeRequest({ ...VALID_EMAIL, messageId: '<dup-1@example.com>' });
    // 1 回目は通常起票
    const res1 = await POST(req());
    expect(res1.status).toBe(201);
    const { ticketId } = (await res1.json()) as { ticketId: string };
    // 2 回目 (再送) は新規起票せず duplicate として 200 + 同じ ticketId を返す
    const res2 = await POST(req());
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { ticketId: string; status?: string };
    expect(body2.status).toBe('duplicate');
    expect(body2.ticketId).toBe(ticketId);
    // チケットは 1 件のまま
    expect(store.tickets.size).toBe(1);
  });

  // スレッド継続: 参照先が別テナントの Message-ID なら一致せず、新規起票にフォールバックする
  it('別テナントの Message-ID には紐付かず新規起票する', async () => {
    // 別テナントに Message-ID を直接登録しておく (別テナントのスレッド)
    await repos.emailThreads.register({
      messageId: 'foreign@example.com',
      ticketId: 't-foreign',
      tenantId: 'other',
    });
    const { POST } = await import('@/app/api/inbound/email/route');
    // default-tenant 宛メールが、別テナントの Message-ID を In-Reply-To で参照しても紐付かない
    const res = await POST(
      makeRequest({
        ...VALID_EMAIL,
        messageId: '<new-1@example.com>',
        inReplyTo: '<foreign@example.com>',
      }),
    );
    // 新規起票 (201) になり、コメント追記ではない
    expect(res.status).toBe(201);
    expect(store.comments.size).toBe(0);
    expect(store.tickets.size).toBe(1);
  });
});
