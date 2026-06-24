// POST /api/inbound/line (Phase 2 LINE 取り込み) の Route Handler テスト。
// 署名検証済みの本文を渡し、(a) ワンタイムコード送信での連携 (起票しない)、
// (b) 連携済みユーザーの起票者が本人になる、(c) 未連携はプロキシ担当者、を検証する (DB は持ち込まない)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
import { hashLineLinkCode, normalizeLineLinkCode } from '@/lib/line-link';

const SECRET = 'test-line-channel-secret';
const TENANT = 'default-tenant';
const AGENT_ID = 'u-agent-1';
const MEMBER_ID = 'u-member-1';

let store: Store;
let repos: Repos;

// @/data を差し替え (getter で beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// テナント + プロキシ担当者 1 名をシードする
function seed() {
  const now = new Date();
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode: 'lite',
    industry: null,
    inboundToken: 'tok',
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
  // プロキシ起票者になる担当者 (未連携ユーザーのフォールバック先)
  store.users.set(AGENT_ID, {
    id: AGENT_ID,
    email: 'agent@example.com',
    name: '担当 太郎',
    passwordHash: 'x',
    role: 'agent',
    tenantId: TENANT,
    createdAt: now,
    updatedAt: now,
  });
}

// LINE 署名を計算する (X-Line-Signature = Base64(HMAC-SHA256(body, secret)))
function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body, 'utf8').digest('base64');
}

// 1 件のテキストメッセージイベントを含む署名付きリクエストを組み立てる
function makeRequest(text: string, userId: string): Request {
  const body = JSON.stringify({
    events: [
      {
        type: 'message',
        source: { type: 'user', userId },
        message: { type: 'text', id: 'm1', text },
      },
    ],
  });
  return new Request('http://localhost/api/inbound/line', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign(body) },
    body,
  });
}

describe('POST /api/inbound/line', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    seed();
    vi.stubEnv('LINE_CHANNEL_SECRET', SECRET);
    vi.stubEnv('LINE_TARGET_TENANT_ID', TENANT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // 未連携ユーザーの通常メッセージはプロキシ担当者を起票者にして起票する
  it('未連携ユーザーのメッセージはプロキシ担当者で起票する', async () => {
    const { POST } = await import('@/app/api/inbound/line/route');
    const res = await POST(makeRequest('プリンターが動きません', 'Uunlinked'));
    expect(res.status).toBe(200);
    expect(store.tickets.size).toBe(1);
    const ticket = Array.from(store.tickets.values())[0];
    // 未連携なので起票者はプロキシ担当者
    expect(ticket.creatorId).toBe(AGENT_ID);
  });

  // 連携済みユーザーのメッセージは本人を起票者にする (自己解決 UI 開通)
  it('連携済みユーザーのメッセージは本人を起票者にする', async () => {
    // Uline1 を MEMBER_ID に連携済みにしておく
    const now = new Date();
    store.users.set(MEMBER_ID, {
      id: MEMBER_ID,
      email: 'member@example.com',
      name: '依頼 花子',
      passwordHash: 'x',
      role: 'requester',
      tenantId: TENANT,
      createdAt: now,
      updatedAt: now,
      lineUserId: 'Uline1',
    });
    const { POST } = await import('@/app/api/inbound/line/route');
    const res = await POST(makeRequest('パソコンが重いです', 'Uline1'));
    expect(res.status).toBe(200);
    const ticket = Array.from(store.tickets.values())[0];
    // 連携済みなので起票者は本人 (担当者ではない)
    expect(ticket.creatorId).toBe(MEMBER_ID);
  });

  // 発行済みコードを送ると連携が成立し、チケットは作られない
  it('発行済みコードの送信で連携し、起票はしない', async () => {
    const now = new Date();
    // コード未連携のメンバーに発行中コードをセットしておく
    const rawCode = 'AB7K-9QF2';
    const codeHash = await hashLineLinkCode(normalizeLineLinkCode(rawCode));
    store.users.set(MEMBER_ID, {
      id: MEMBER_ID,
      email: 'member@example.com',
      name: '依頼 花子',
      passwordHash: 'x',
      role: 'requester',
      tenantId: TENANT,
      createdAt: now,
      updatedAt: now,
      lineLinkCodeHash: codeHash,
      lineLinkCodeExpiresAt: new Date(Date.now() + 60_000),
    });
    const { POST } = await import('@/app/api/inbound/line/route');
    // ユーザーがコードを (小文字・ハイフン無しで) 送ってきても正規化で一致する
    const res = await POST(makeRequest('ab7k9qf2', 'UlineNew'));
    expect(res.status).toBe(200);
    // 連携が成立し、チケットは作られない
    expect(store.tickets.size).toBe(0);
    expect(store.users.get(MEMBER_ID)?.lineUserId).toBe('UlineNew');
    // 発行中コードは消費済み
    expect(store.users.get(MEMBER_ID)?.lineLinkCodeHash).toBeNull();
  });

  // コードの形だが発行行が無いテキストは通常の問い合わせとして起票する
  it('コード形だが未発行のテキストは通常起票する', async () => {
    const { POST } = await import('@/app/api/inbound/line/route');
    // looksLike を満たす 8 文字だが発行行が無い
    const res = await POST(makeRequest('ZZ112233', 'Uunlinked'));
    expect(res.status).toBe(200);
    // 連携ではなく通常起票になる
    expect(store.tickets.size).toBe(1);
    expect(Array.from(store.tickets.values())[0].creatorId).toBe(AGENT_ID);
  });

  // 署名が不正なリクエストは 401 で拒否する
  it('署名が不正なら 401 を返す', async () => {
    const body = JSON.stringify({ events: [] });
    const req = new Request('http://localhost/api/inbound/line', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-line-signature': 'wrong' },
      body,
    });
    const { POST } = await import('@/app/api/inbound/line/route');
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(store.tickets.size).toBe(0);
  });
});
