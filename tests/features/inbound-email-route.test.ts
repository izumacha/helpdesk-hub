// POST /api/inbound/email (Phase 2 メール取り込み) の Route Handler テスト。
// シークレット検証 / テナント特定 / 送信者検証 (隔離) / Lite 起票の挙動を、
// メモリアダプタと環境変数スタブで検証する (DB を持ち込まない)。

// Vitest の DSL とモック機能
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// メモリストレージ (添付バイナリ用。フォローアップ 2026-07-13)
import { createMemoryStorage, type MemoryStoragePort } from '@/data/adapters/memory/storage.memory';
// 型のみ
import type { Repos } from '@/data/ports/unit-of-work';

// テスト用の固定値
const SECRET = 'test-inbound-secret';
const TENANT = 'default-tenant';
const TOKEN = 'abc123';
const MEMBER_EMAIL = 'ichiro@example.com';
const MEMBER_ID = 'u-member-1';
// 初回応答 SLA テスト用のエージェント (担当者役)
const AGENT_EMAIL = 'agent@example.com';
const AGENT_ID = 'u-agent-1';
// 隔離記録テスト用の第三者メンバー (他人のチケットへの追記権限が無い requester)
const OTHER_MEMBER_EMAIL = 'jiro@example.com';
const OTHER_MEMBER_ID = 'u-member-2';

// UnitOfWork 型 (スレッド継続のコメント追記でトランザクションを使う)
import type { UnitOfWork } from '@/data/ports/unit-of-work';

// 外部通知 (Slack/Teams/Chatwork) テスト用の Slack Webhook URL (実際には送信されない)
const SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/xxx';

// src/lib/webhook-fetch.ts は SSRF 対策の DNS 検証用 Dispatcher (Agent) を使うため
// undici の fetch を直接 import している。vi.stubGlobal('fetch', ...) だけでは差し替わらない
// ため、undici の fetch を globalThis.fetch へ委譲するモックにする (他テストへは影響しない)
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: ((...args: Parameters<typeof globalThis.fetch>) =>
      globalThis.fetch(...args)) as unknown as typeof actual.fetch,
  };
});

// getMonthlyTicketQuota だけ差し替え可能にする (実装は既定で本物を使い、上限到達テストでのみ
// 上書きする)。Standard/Pro プランは現状無制限 (Infinity) のため、実際のプラン設定だけでは
// 上限到達を再現できず、この関数の呼び出し配線自体を検証する必要があるため
const { getMonthlyTicketQuotaMock } = vi.hoisted(() => ({
  getMonthlyTicketQuotaMock: vi.fn(),
}));
vi.mock('@/lib/tenant-plan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tenant-plan')>();
  getMonthlyTicketQuotaMock.mockImplementation(actual.getMonthlyTicketQuota);
  return { ...actual, getMonthlyTicketQuota: getMonthlyTicketQuotaMock };
});

// 各テストで差し替える可変な依存 (Route import 前に値を入れる)
let store: Store;
let repos: Repos;
let uow: UnitOfWork;
// 添付ファイルのバイナリ本体を保持するメモリストレージ (フォローアップ 2026-07-13)
let storage: MemoryStoragePort;

// @/data を差し替え (getter で beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
  get uow() {
    return uow;
  },
}));

// storage は別モジュール (Edge runtime 汚染回避のため route.ts が個別 import している)
vi.mock('@/data/storage', () => ({
  get storage() {
    return storage;
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

// 受領自動返信 (メンバー改善 #1) の送信を捕捉する。実ファイル (.magic-link-outbox.jsonl) へ
// 書き込む console ドライバを避け、送信内容を配列に貯めて検証する。
// vi.hoisted で先に配列を作り、vi.mock のファクトリから参照できるようにする (巻き上げ順序対策)。
const { sentEmails } = vi.hoisted(() => ({
  sentEmails: [] as Array<{ to: string; subject: string }>,
}));
vi.mock('@/lib/email', () => ({
  getEmailSender: () => ({
    send: async (message: { to: string; subject: string }) => {
      sentEmails.push(message);
    },
  }),
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
    slackWebhookUrl: null,
    // メール取り込みは Free では利用不可 (§6.1) なので、既定シードは Standard にする
    subscriptionPlan: 'standard' as const,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null, // Slack 通知未設定 (テスト用フィクスチャ)
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
  // テナント所属のエージェント (初回応答 SLA テストで使う)
  store.users.set(AGENT_ID, {
    id: AGENT_ID,
    email: AGENT_EMAIL,
    name: '田中 担当',
    passwordHash: 'x',
    role: 'agent',
    tenantId: TENANT,
    createdAt: now,
    updatedAt: now,
  });
  // テナント所属の第三者メンバー (隔離記録テストで使う。他人のチケットへの追記権限が無い requester)
  store.users.set(OTHER_MEMBER_ID, {
    id: OTHER_MEMBER_ID,
    email: OTHER_MEMBER_EMAIL,
    name: '次郎',
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
    // 添付ファイル用のメモリストレージも毎回作り直す (フォローアップ 2026-07-13)
    storage = createMemoryStorage();
    seed();
    vi.stubEnv('INBOUND_EMAIL_SECRET', SECRET);
    // 各テストで送信捕捉バッファを空にする (テスト間で送信が混ざらないように)
    sentEmails.length = 0;
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
    // 回帰防止: firstResponseDueAt が配線されておらず常に null のまま起票される不備があった
    expect(ticket?.firstResponseDueAt).not.toBeNull();
  });

  // 回帰防止: メール起票が Slack 等の外部通知 (オプトイン) にしか頼っておらず、
  // LINE 取り込み・CSV インポートと違ってエージェントへのアプリ内通知が一切無かった不備の修正確認
  it('新規起票時にテナント内の全エージェントへ imported 通知を作成する', async () => {
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest(VALID_EMAIL));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ticketId: string };
    // エージェント (AGENT_ID) 宛に 'imported' 種別の通知が作成されていること
    const notifications = [...store.notifications.values()].filter((n) => n.userId === AGENT_ID);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe('imported');
    expect(notifications[0]?.ticketId).toBe(json.ticketId);
    expect(notifications[0]?.tenantId).toBe(TENANT);
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

  // Free プランはメール取り込み不可 (§6.1 料金プラン)。既知メンバーでも隔離して起票しない
  it('Free プランのテナントは隔離して 202 を返す (プランゲート)', async () => {
    // シード済みテナントを Free プランに書き換える
    store.tenants.set(TENANT, { ...store.tenants.get(TENANT)!, subscriptionPlan: 'free' as const });
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest(VALID_EMAIL));
    expect(res.status).toBe(202);
    expect(store.tickets.size).toBe(0);
  });

  // 回帰防止: §7.2「30日間の Free trial (Standard 相当)」中は、Free プランのままでも
  // メール取り込みが解禁される (オンボーディングのメール転送体験を課金前でも試せるようにする)
  it('トライアル期間中の Free プランは起票できる (トライアル昇格)', async () => {
    const tenant = store.tenants.get(TENANT)!;
    // Free プラン + 未来の trialEndsAt (トライアル中) に書き換える
    store.tenants.set(TENANT, {
      ...tenant,
      subscriptionPlan: 'free' as const,
      trialEndsAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    });
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest(VALID_EMAIL));
    expect(res.status).toBe(201);
    expect(store.tickets.size).toBe(1);
  });

  // トライアル終了済みなら通常どおり Free プランとして隔離される
  it('トライアル終了済みの Free プランは隔離される', async () => {
    const tenant = store.tenants.get(TENANT)!;
    store.tenants.set(TENANT, {
      ...tenant,
      subscriptionPlan: 'free' as const,
      trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest(VALID_EMAIL));
    expect(res.status).toBe(202);
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
      slackWebhookUrl: null,
      subscriptionPlan: 'free' as const,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      trialEndsAt: null,
      teamsWebhookUrl: null,
      chatworkApiToken: null,
      chatworkRoomId: null, // Slack 通知未設定 (テスト用フィクスチャ)
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

  // SLA: メール経由のスレッド継続でも、エージェントの返信を初回応答として記録する
  // (Web フォーム経由コメント/comments/route.ts と同じ扱いにするための回帰テスト)
  it('スレッド継続でエージェントが返信すると firstRespondedAt が記録される', async () => {
    const { POST } = await import('@/app/api/inbound/email/route');
    // 依頼者からのメールで 1 件起票する
    const res1 = await POST(makeRequest({ ...VALID_EMAIL, messageId: '<orig-2@example.com>' }));
    expect(res1.status).toBe(201);
    const { ticketId } = (await res1.json()) as { ticketId: string };
    // 起票直後は未応答 (firstRespondedAt は null)
    expect(store.tickets.get(ticketId)?.firstRespondedAt).toBeNull();

    // エージェントが起票メールへ返信する (In-Reply-To で元 Message-ID を参照)
    const res2 = await POST(
      makeRequest({
        to: VALID_EMAIL.to,
        from: `田中 担当 <${AGENT_EMAIL}>`,
        subject: 'Re: プリンターが動きません',
        text: '確認して対応します',
        messageId: '<agent-reply-1@example.com>',
        inReplyTo: '<orig-2@example.com>',
      }),
    );
    expect(res2.status).toBe(200);
    // 初回応答日時が記録されている
    expect(store.tickets.get(ticketId)?.firstRespondedAt).not.toBeNull();
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

  // 書き込み競合 (Serializable 分離レベルでの中断) が起きても、対応表を読み直して
  // 重複扱いにし、二重にチケットを作らないことを確認する。
  // 実際の Postgres での競合は契約テスト (RUN_PRISMA_CONTRACT=1 が必要) で検証し、
  // ここでは createEmailTicketIdempotent のエラーハンドリング分岐
  // (uow.isTransactionConflict → 対応表の再読込) を検証する。
  it('書き込み競合が起きても対応表を読み直して重複扱いにする (二重起票しない)', async () => {
    // 「別リクエストが先に確定させた」チケットをあらかじめ用意しておく
    const winnerTicket = await repos.tickets.create({
      title: '先勝ちリクエストが作成',
      body: '本文',
      priority: 'Medium',
      categoryId: null,
      creatorId: MEMBER_ID,
      tenantId: TENANT,
    });

    // findTicketIdByMessageIds: 1 回目 (事前チェック) は null、2 回目以降 (競合後の再確認) は
    // 先勝ちチケット ID を返す。「事前チェックの時点では未処理だったが、その後 (このリクエストの
    // トランザクションが競合で中断される間に) 別リクエストが確定させた」という順序を再現する
    const findTicketIdByMessageIds = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(winnerTicket.id);
    repos = {
      ...repos,
      emailThreads: { ...repos.emailThreads, findTicketIdByMessageIds },
    };

    // uow.run を「書き込み競合で必ず失敗する」実装に差し替える
    const conflictError = new Error('simulated write conflict');
    uow = {
      run: vi.fn(async () => {
        throw conflictError;
      }),
      isTransactionConflict: (err) => err === conflictError,
    };

    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest({ ...VALID_EMAIL, messageId: '<race-1@example.com>' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticketId: string; status?: string };
    expect(body.status).toBe('duplicate');
    expect(body.ticketId).toBe(winnerTicket.id);
    // 新規チケットは作られず、先勝ちの 1 件のままであること
    expect(store.tickets.size).toBe(1);
    // 受領自動返信は既に先勝ちリクエスト側で送られているはずなので、ここでは送らない
    expect(sentEmails).toHaveLength(0);
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

  // ── 送信元ドメイン認証 (SPF/DKIM/DMARC) ポリシー ───────────────────────────
  // INBOUND_EMAIL_AUTH=enforce のとき、SPF が明示 fail のメールを隔離 (202) して起票しない
  it('enforce で SPF=fail のメールを隔離する (202)', async () => {
    vi.stubEnv('INBOUND_EMAIL_AUTH', 'enforce');
    const { POST } = await import('@/app/api/inbound/email/route');
    // 既知メンバーからのメールでも、SPF=fail なら詐称を疑い隔離する
    const res = await POST(makeRequest({ ...VALID_EMAIL, SPF: 'fail' }));
    expect(res.status).toBe(202);
    expect(store.tickets.size).toBe(0); // 起票されない
  });

  // enforce でも SPF=pass の既知メンバーは通常どおり起票される
  it('enforce で SPF=pass のメールは起票する (201)', async () => {
    vi.stubEnv('INBOUND_EMAIL_AUTH', 'enforce');
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest({ ...VALID_EMAIL, SPF: 'pass' }));
    expect(res.status).toBe(201);
    expect(store.tickets.size).toBe(1);
  });

  // enforce + 認証結果が無い (unknown) メールは誤隔離せず起票する (可用性優先 / 後方互換)
  it('enforce でも認証結果が無ければ起票する (201)', async () => {
    vi.stubEnv('INBOUND_EMAIL_AUTH', 'enforce');
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest(VALID_EMAIL));
    expect(res.status).toBe(201);
    expect(store.tickets.size).toBe(1);
  });

  // 既定 (off) では SPF=fail でも検証せず従来どおり起票する (後方互換)
  it('off (既定) では SPF=fail でも起票する (201)', async () => {
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest({ ...VALID_EMAIL, SPF: 'fail' }));
    expect(res.status).toBe(201);
    expect(store.tickets.size).toBe(1);
  });

  // enforce で Authentication-Results ヘッダの dmarc=fail を隔離する
  it('enforce で Authentication-Results の dmarc=fail を隔離する (202)', async () => {
    vi.stubEnv('INBOUND_EMAIL_AUTH', 'enforce');
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(
      makeRequest({
        ...VALID_EMAIL,
        'authentication-results': 'mx; spf=pass; dkim=pass; dmarc=fail',
      }),
    );
    expect(res.status).toBe(202);
    expect(store.tickets.size).toBe(0);
  });

  // multipart (SendGrid 形式) の個別 SPF フィールド (大文字 'SPF') も enforce で隔離されること。
  // 大文字/小文字フィールド名の取り違えは静かに壊れやすいため、multipart 経路を明示的に検証する。
  it('enforce で multipart の SPF=fail フィールドを隔離する (202)', async () => {
    vi.stubEnv('INBOUND_EMAIL_AUTH', 'enforce');
    // SendGrid 互換の multipart フォームを組み立てる
    const form = new FormData();
    form.set('to', `${TOKEN}@inbox.helpdesk-hub.app`);
    form.set('from', '鈴木 一郎 <ichiro@example.com>'); // 既知メンバー (本人性はここ)
    form.set('subject', 'マルチパート SPF 失敗');
    form.set('text', '本文');
    form.set('SPF', 'fail'); // プロバイダ算出の SPF=fail (詐称シグナル)
    const req = new Request('http://localhost/api/inbound/email', {
      method: 'POST',
      headers: { 'x-inbound-secret': SECRET },
      body: form,
    });
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(req);
    // 既知メンバーであっても SPF=fail なら隔離されて起票されない
    expect(res.status).toBe(202);
    expect(store.tickets.size).toBe(0);
  });

  // enforce で個別 dkim フィールドの fail を隔離する (SendGrid の dkim フィールド形式)
  it('enforce で dkim フィールドの fail を隔離する (202)', async () => {
    vi.stubEnv('INBOUND_EMAIL_AUTH', 'enforce');
    const { POST } = await import('@/app/api/inbound/email/route');
    // SendGrid の dkim フィールドは "{@domain : result}" 形式
    const res = await POST(makeRequest({ ...VALID_EMAIL, dkim: '{@example.com : fail}' }));
    expect(res.status).toBe(202);
    expect(store.tickets.size).toBe(0);
  });

  // ── 受領自動返信 (メンバー改善 #1) ────────────────────────────────────────
  // 新規起票が成功したら、送信元へ受付番号付きの受領メールを 1 通だけ返す
  it('新規起票時に送信元へ受領自動返信を 1 通送る', async () => {
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest(VALID_EMAIL));
    expect(res.status).toBe(201);
    const { ticketId } = (await res.json()) as { ticketId: string };
    // 送信は 1 通だけ。宛先は送信元の既知メンバー
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe(MEMBER_EMAIL);
    // 件名に受付番号 (短縮 ID) と件名が含まれる
    expect(sentEmails[0].subject).toContain(`#${ticketId.slice(0, 8)}`);
    expect(sentEmails[0].subject).toContain('プリンターが動きません');
  });

  // スレッド継続 (既存チケットへの追記) では受領自動返信を送らない (既に会話中のため)
  it('スレッド追記では受領自動返信を送らない', async () => {
    const { POST } = await import('@/app/api/inbound/email/route');
    // 1 通目: 新規起票 → 受領返信 1 通
    await POST(makeRequest({ ...VALID_EMAIL, messageId: '<orig-ack@example.com>' }));
    expect(sentEmails).toHaveLength(1);
    // 2 通目: 同じスレッドへの返信 (In-Reply-To) → 追記なので受領返信は増えない
    const res2 = await POST(
      makeRequest({
        ...VALID_EMAIL,
        subject: 'Re: プリンターが動きません',
        text: 'まだ直りません',
        messageId: '<reply-ack@example.com>',
        inReplyTo: '<orig-ack@example.com>',
      }),
    );
    expect(res2.status).toBe(200);
    expect(sentEmails).toHaveLength(1);
  });

  // 同一 Message-ID の再送 (重複) では受領自動返信を送らない (二重送信防止)
  it('重複再送では受領自動返信を送らない', async () => {
    const { POST } = await import('@/app/api/inbound/email/route');
    const req = () => makeRequest({ ...VALID_EMAIL, messageId: '<dup-ack@example.com>' });
    await POST(req()); // 1 通目: 起票 + 受領返信
    await POST(req()); // 2 通目: 重複なので何もしない
    expect(sentEmails).toHaveLength(1);
  });

  // 自動配信メール (Auto-Submitted) には受領自動返信を送らない (メールループ防止)
  it('Auto-Submitted の自動配信メールには受領自動返信を送らない', async () => {
    const { POST } = await import('@/app/api/inbound/email/route');
    const res = await POST(makeRequest({ ...VALID_EMAIL, 'auto-submitted': 'auto-generated' }));
    // 起票自体は通常どおり成功するが、受領返信は送らない
    expect(res.status).toBe(201);
    expect(store.tickets.size).toBe(1);
    expect(sentEmails).toHaveLength(0);
  });

  // 回帰防止: 新規起票を Slack/Teams/Chatwork の外部チャネルへ通知する (Web フォーム/LINE/CSV と共有)。
  // 従来は Web フォーム (POST /api/tickets) にしか配線されておらず、メール取り込み経由の起票は
  // 担当者チームの Slack に気づかれないまま埋もれてしまっていた。
  describe('外部通知 (Slack/Teams/Chatwork)', () => {
    // 各テストで fetch をモックする (Slack Adapter が呼ぶ)
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('ok') });
      vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('Slack Webhook 設定済みテナントで新規起票すると Slack へ通知される', async () => {
      // シード済みテナントに Slack Webhook を設定する
      const tenant = store.tenants.get(TENANT)!;
      store.tenants.set(TENANT, { ...tenant, slackWebhookUrl: SLACK_WEBHOOK_URL });

      const { POST } = await import('@/app/api/inbound/email/route');
      const res = await POST(makeRequest(VALID_EMAIL));
      expect(res.status).toBe(201);

      // Slack Webhook へ 1 回だけ POST される
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(SLACK_WEBHOOK_URL);
      const payload = JSON.parse(init.body);
      expect(JSON.stringify(payload)).toContain('プリンターが動きません');
    });

    it('外部通知が未設定のテナントで新規起票しても fetch は呼ばれない', async () => {
      const { POST } = await import('@/app/api/inbound/email/route');
      const res = await POST(makeRequest(VALID_EMAIL));
      expect(res.status).toBe(201);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // スレッド追記 (新規起票ではない) では新規チケット向けの外部通知を送らない
    it('スレッド追記では外部通知を送らない', async () => {
      const tenant = store.tenants.get(TENANT)!;
      store.tenants.set(TENANT, { ...tenant, slackWebhookUrl: SLACK_WEBHOOK_URL });

      // 1 通目: 新規起票 (ここで 1 回通知される)
      const { POST } = await import('@/app/api/inbound/email/route');
      const first = await POST(
        makeRequest({ ...VALID_EMAIL, messageId: '<thread-1@example.com>' }),
      );
      expect(first.status).toBe(201);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // 2 通目: 1 通目への返信 (In-Reply-To で同じチケットへ追記)
      fetchMock.mockClear();
      const reply = await POST(
        makeRequest({
          ...VALID_EMAIL,
          messageId: '<thread-2@example.com>',
          inReplyTo: '<thread-1@example.com>',
        }),
      );
      expect(reply.status).toBe(200);
      // スレッド追記では「新規起票」通知を重複して送らない
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // 回帰防止: 月間チケット上限 (§6.1 料金プラン)。Web フォーム・CSV インポートと共有する
  // getMonthlyTicketQuota が、メール取り込みからも呼ばれることを確認する。
  // Standard プランは現状無制限のため、この関数自体をモックして上限到達を再現する。
  describe('月間チケット上限 (§6.1 料金プラン)', () => {
    it('上限到達済みなら隔離して 202 を返し、起票しない', async () => {
      // 残枠 0 の状態を再現する
      getMonthlyTicketQuotaMock.mockResolvedValueOnce({ limited: true, limit: 10, remaining: 0 });
      const { POST } = await import('@/app/api/inbound/email/route');
      const res = await POST(makeRequest(VALID_EMAIL));
      expect(res.status).toBe(202);
      expect(store.tickets.size).toBe(0);
    });

    it('残枠があれば通常どおり起票する', async () => {
      getMonthlyTicketQuotaMock.mockResolvedValueOnce({ limited: true, limit: 10, remaining: 3 });
      const { POST } = await import('@/app/api/inbound/email/route');
      const res = await POST(makeRequest(VALID_EMAIL));
      expect(res.status).toBe(201);
      expect(store.tickets.size).toBe(1);
    });
  });

  // §3.2 フォローアップ (2026-07-09): 隔離した受信メールは以前 console.warn にしか残らず、
  // admin が /quarantine 一覧から確認できなかった。5 通りの隔離理由すべてで QuarantinedEmail が
  // 永続化されることの回帰テスト
  describe('隔離記録の永続化 (§3.2 フォローアップ)', () => {
    it('プランゲートで隔離すると reason=plan_gate で記録される', async () => {
      store.tenants.set(TENANT, { ...store.tenants.get(TENANT)!, subscriptionPlan: 'free' });
      const { POST } = await import('@/app/api/inbound/email/route');
      const res = await POST(makeRequest(VALID_EMAIL));
      expect(res.status).toBe(202);
      expect(store.quarantinedEmails.size).toBe(1);
      const record = Array.from(store.quarantinedEmails.values())[0];
      expect(record.reason).toBe('plan_gate');
      expect(record.tenantId).toBe(TENANT);
      expect(record.senderAddress).toBe(MEMBER_EMAIL);
    });

    it('送信元認証失敗で隔離すると reason=auth_fail で記録される', async () => {
      vi.stubEnv('INBOUND_EMAIL_AUTH', 'enforce');
      const { POST } = await import('@/app/api/inbound/email/route');
      const res = await POST(makeRequest({ ...VALID_EMAIL, spf: 'fail' }));
      expect(res.status).toBe(202);
      expect(store.quarantinedEmails.size).toBe(1);
      expect(Array.from(store.quarantinedEmails.values())[0].reason).toBe('auth_fail');
    });

    it('未知送信者で隔離すると reason=unknown_sender で記録される', async () => {
      const { POST } = await import('@/app/api/inbound/email/route');
      const res = await POST(
        makeRequest({ ...VALID_EMAIL, from: '知らない人 <unknown@example.com>' }),
      );
      expect(res.status).toBe(202);
      expect(store.quarantinedEmails.size).toBe(1);
      const record = Array.from(store.quarantinedEmails.values())[0];
      expect(record.reason).toBe('unknown_sender');
      expect(record.senderAddress).toBe('unknown@example.com');
    });

    it('スレッド追記権限が無い送信者で隔離すると reason=thread_forbidden で記録される', async () => {
      const { POST } = await import('@/app/api/inbound/email/route');
      // MEMBER が起票する
      const res1 = await POST(makeRequest({ ...VALID_EMAIL, messageId: '<orig-3@example.com>' }));
      expect(res1.status).toBe(201);
      // 第三者メンバー (起票者でもエージェントでもない) がそのチケットへ返信しようとする
      const res2 = await POST(
        makeRequest({
          to: VALID_EMAIL.to,
          from: `次郎 <${OTHER_MEMBER_EMAIL}>`,
          subject: 'Re: プリンターが動きません',
          text: '横から失礼します',
          messageId: '<intruder-1@example.com>',
          inReplyTo: '<orig-3@example.com>',
        }),
      );
      expect(res2.status).toBe(202);
      expect(store.quarantinedEmails.size).toBe(1);
      const record = Array.from(store.quarantinedEmails.values())[0];
      expect(record.reason).toBe('thread_forbidden');
      expect(record.senderAddress).toBe(OTHER_MEMBER_EMAIL);
    });

    it('月間上限到達で隔離すると reason=quota_exceeded で記録される', async () => {
      getMonthlyTicketQuotaMock.mockResolvedValueOnce({ limited: true, limit: 10, remaining: 0 });
      const { POST } = await import('@/app/api/inbound/email/route');
      const res = await POST(makeRequest(VALID_EMAIL));
      expect(res.status).toBe(202);
      expect(store.quarantinedEmails.size).toBe(1);
      expect(Array.from(store.quarantinedEmails.values())[0].reason).toBe('quota_exceeded');
    });
  });

  // フォローアップ (2026-07-13): 監査で発見したギャップの解消。SendGrid Inbound Parse の
  // 添付ファイル (attachments 件数 + attachment1..N) を一切読んでおらず、スマホで撮った写真を
  // メールに添付して送るだけで済ませたい SMB ペルソナ (§1.2) の主要ユースケースがメール経由では
  // 実現できていなかった不備の回帰テスト。
  describe('添付ファイル (フォローアップ 2026-07-13)', () => {
    // 既知のマジックバイト (validateUploadedFiles の整合チェックを通すため必要。
    // tests/features/attachments/post-comment-route.test.ts と同じ方式)
    const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    // 申告 MIME に対応するマジックバイトを先頭に置いた File を作る
    function makeAttachmentFile(name: string, type: string, body: string): File {
      const text = new TextEncoder().encode(body);
      const data = type === 'image/png' ? new Uint8Array([...PNG_MAGIC, ...text]) : text;
      return new File([data], name, { type });
    }

    // SendGrid Inbound Parse 形式 (attachments 件数 + attachment1..N) の multipart Request を組み立てる
    function makeAttachmentRequest(fields: Record<string, string>, files: File[]): Request {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      if (files.length > 0) {
        form.set('attachments', String(files.length));
        files.forEach((f, i) => form.set(`attachment${i + 1}`, f, f.name));
      }
      return new Request('http://localhost/api/inbound/email', {
        method: 'POST',
        headers: { 'x-inbound-secret': SECRET },
        body: form,
      });
    }

    // 新規起票 + 有効な画像添付 1 枚 → チケット作成 + 添付メタ INSERT (commentId は null) +
    // バイト列が storage に書かれること
    it('新規起票時に有効な画像添付があれば保存される', async () => {
      const file = makeAttachmentFile('photo.png', 'image/png', 'fake-image-bytes');
      const { POST } = await import('@/app/api/inbound/email/route');
      const res = await POST(
        makeAttachmentRequest(
          {
            to: VALID_EMAIL.to,
            from: VALID_EMAIL.from,
            subject: VALID_EMAIL.subject,
            text: VALID_EMAIL.text,
          },
          [file],
        ),
      );
      expect(res.status).toBe(201);
      const json = (await res.json()) as { ticketId: string };
      // チケットに紐づく添付が 1 件、commentId は null (新規起票への添付) で記録される
      const attachments = [...store.attachments.values()].filter(
        (a) => a.ticketId === json.ticketId,
      );
      expect(attachments).toHaveLength(1);
      expect(attachments[0].commentId).toBeNull();
      expect(attachments[0].originalName).toBe('photo.png');
      // storage にバイト列が実際に書き込まれていること
      expect(storage.entries.size).toBe(1);
    });

    // スレッド追記 (既存チケットへのコメント) + 有効な画像添付 → コメントに紐づけて保存されること
    it('スレッド追記時に有効な画像添付があればコメントに紐づけて保存される', async () => {
      const { POST } = await import('@/app/api/inbound/email/route');
      // 1 通目: 新規起票 (添付なし)
      const first = await POST(
        makeRequest({ ...VALID_EMAIL, messageId: '<attach-thread-1@example.com>' }),
      );
      expect(first.status).toBe(201);
      const { ticketId } = (await first.json()) as { ticketId: string };

      // 2 通目: 1 通目への返信に画像添付
      const file = makeAttachmentFile('reply-photo.png', 'image/png', 'reply-bytes');
      const reply = await POST(
        makeAttachmentRequest(
          {
            to: VALID_EMAIL.to,
            from: VALID_EMAIL.from,
            subject: 'Re: プリンターが動きません',
            text: '追加の写真です',
            'in-reply-to': '<attach-thread-1@example.com>',
            'message-id': '<attach-thread-2@example.com>',
          },
          [file],
        ),
      );
      expect(reply.status).toBe(200);
      // コメントに紐づく添付が 1 件記録されていること (commentId が非 null)
      const attachments = [...store.attachments.values()].filter((a) => a.ticketId === ticketId);
      expect(attachments).toHaveLength(1);
      expect(attachments[0].commentId).not.toBeNull();
      expect(storage.entries.size).toBe(1);
    });

    // 許可外 MIME の添付があっても、メール全体 (起票) を止めずに添付なしで処理を継続すること。
    // Web フォーム/コメント投稿と異なりこの Webhook にはユーザーへの即時フィードバック画面が無いため、
    // 添付だけを黙って落として本文だけは問い合わせとして残す方針 (route.ts のコメント参照)
    it('許可外 MIME の添付は無視され、本文だけで起票される', async () => {
      const file = makeAttachmentFile('doc.pdf', 'application/pdf', 'not-an-image');
      const { POST } = await import('@/app/api/inbound/email/route');
      const res = await POST(
        makeAttachmentRequest(
          {
            to: VALID_EMAIL.to,
            from: VALID_EMAIL.from,
            subject: VALID_EMAIL.subject,
            text: VALID_EMAIL.text,
          },
          [file],
        ),
      );
      // 添付が拒否されても起票自体は成功する
      expect(res.status).toBe(201);
      const json = (await res.json()) as { ticketId: string };
      expect(store.tickets.get(json.ticketId)?.body).toBe(VALID_EMAIL.text);
      // 添付は 1 件も記録されない (無言で落とす)
      expect(
        [...store.attachments.values()].filter((a) => a.ticketId === json.ticketId),
      ).toHaveLength(0);
      expect(storage.entries.size).toBe(0);
    });

    // 添付が無いメールは従来どおり (回帰なし)
    it('添付が無いメールは従来どおり起票され、attachments テーブルは空のまま', async () => {
      const { POST } = await import('@/app/api/inbound/email/route');
      const res = await POST(makeRequest(VALID_EMAIL));
      expect(res.status).toBe(201);
      expect(store.attachments.size).toBe(0);
      expect(storage.entries.size).toBe(0);
    });

    // /code-review ultra 指摘対応の回帰テスト (2026-07-13): 以前は validateUploadedFiles が
    // 1 件でも不正な添付があれば全件を切り捨てていたため、有効な画像と無効なファイルが混在した
    // メールでは有効な写真まで一緒に失われていた。validateUploadedFilesLenient は無効な分だけを
    // 落とし、有効な添付は保存されることを確認する
    it('有効な添付と無効な添付が混在していても、有効な分だけ保存される', async () => {
      const goodFile = makeAttachmentFile('good.png', 'image/png', 'valid-image-bytes');
      const badFile = makeAttachmentFile('bad.pdf', 'application/pdf', 'not-an-image');
      const { POST } = await import('@/app/api/inbound/email/route');
      const res = await POST(
        makeAttachmentRequest(
          {
            to: VALID_EMAIL.to,
            from: VALID_EMAIL.from,
            subject: VALID_EMAIL.subject,
            text: VALID_EMAIL.text,
          },
          [goodFile, badFile],
        ),
      );
      expect(res.status).toBe(201);
      const json = (await res.json()) as { ticketId: string };
      // 無効な PDF は落とされ、有効な PNG だけが 1 件保存されること
      const attachments = [...store.attachments.values()].filter(
        (a) => a.ticketId === json.ticketId,
      );
      expect(attachments).toHaveLength(1);
      expect(attachments[0].originalName).toBe('good.png');
      expect(storage.entries.size).toBe(1);
    });

    // /code-review ultra 指摘対応の回帰テスト (2026-07-13): Serializable 分離レベルでの書き込み
    // 競合は「コミット時点」で検知されるため、敗者側のトランザクションが onCreated (persistAttachments)
    // で既にストレージへバイト列を書き込み終えた後に競合が発覚するケースがあり得る。DB 側の書き込みは
    // ロールバックされてもストレージ書き込みはトランザクション外の副作用のため残ってしまっていた不備の
    // 修正確認 (alreadyExisted 分岐での cleanupWrittenAttachments 呼び出し)
    it('書き込み競合の敗者側が保存した添付ファイルは重複解決時にクリーンアップされる', async () => {
      // 「別リクエストが先に確定させた」チケットをあらかじめ用意しておく
      const winnerTicket = await repos.tickets.create({
        title: '先勝ちリクエストが作成',
        body: '本文',
        priority: 'Medium',
        categoryId: null,
        creatorId: MEMBER_ID,
        tenantId: TENANT,
      });

      // findTicketIdByMessageIds: 1 回目 (事前チェック) は null、2 回目 (競合後の再確認) は
      // 先勝ちチケット ID を返す
      const findTicketIdByMessageIds = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(winnerTicket.id);
      repos = {
        ...repos,
        emailThreads: { ...repos.emailThreads, findTicketIdByMessageIds },
      };

      // uow.run は渡されたコールバックを実際に実行してから (= このリクエストの「敗者」
      // トランザクションが onCreated で添付をストレージへ書き込み終えてから) 書き込み競合で
      // 失敗させる。実際の Postgres でもコミット時点で初めて競合が検知されるため、
      // ストレージ書き込みが完了した後に DB 側だけロールバックされる、という順序を再現する
      const conflictError = new Error('simulated write conflict');
      uow = {
        run: vi.fn(async (fn) => {
          await fn(repos);
          throw conflictError;
        }),
        isTransactionConflict: (err) => err === conflictError,
      };

      const file = makeAttachmentFile('leak.png', 'image/png', 'leaked-bytes');
      const { POST } = await import('@/app/api/inbound/email/route');
      const res = await POST(
        makeAttachmentRequest(
          {
            to: VALID_EMAIL.to,
            from: VALID_EMAIL.from,
            subject: VALID_EMAIL.subject,
            text: VALID_EMAIL.text,
            'message-id': '<race-attach-1@example.com>',
          },
          [file],
        ),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ticketId: string; status?: string };
      expect(body.status).toBe('duplicate');
      expect(body.ticketId).toBe(winnerTicket.id);
      // 敗者トランザクションが onCreated で書き込んだストレージのバイト列は、重複解決時に
      // クリーンアップされ残らないこと
      expect(storage.entries.size).toBe(0);
    });

    // 回帰防止 (監査で発見したギャップ対応): メールスレッド継続は同じチケットへの追記を
    // 何度でも繰り返せるため、チケット当たりの添付総数上限 (MAX_ATTACHMENTS_PER_TICKET=100)
    // に既に達している場合は、テナント累計サイズ上限と同じく添付なしで取り込みを継続する
    // (Webhook はユーザーへの即時フィードバック画面が無いため、起票/追記自体は失敗させない)
    it('チケットの添付総数が上限に達しているスレッド追記は添付なしで継続される', async () => {
      const { POST } = await import('@/app/api/inbound/email/route');
      // 1 通目: 新規起票 (添付なし)
      const first = await POST(
        makeRequest({ ...VALID_EMAIL, messageId: '<attach-cap-1@example.com>' }),
      );
      expect(first.status).toBe(201);
      const { ticketId } = (await first.json()) as { ticketId: string };

      // このチケットに上限ちょうど (100 件) まで既存添付を積み上げておく
      for (let i = 0; i < 100; i += 1) {
        await repos.attachments.create({
          ticketId,
          commentId: null,
          uploaderId: MEMBER_ID,
          tenantId: TENANT,
          mimeType: 'image/png',
          size: 10,
          originalName: `existing-${i}.png`,
          storageKey: `${TENANT}/${ticketId}/existing-${i}.png`,
          storage: 'local',
        });
      }

      // 2 通目: 1 通目への返信に画像添付 (上限超過)
      const file = makeAttachmentFile('overflow.png', 'image/png', 'overflow-bytes');
      const reply = await POST(
        makeAttachmentRequest(
          {
            to: VALID_EMAIL.to,
            from: VALID_EMAIL.from,
            subject: 'Re: プリンターが動きません',
            text: '101枚目の写真です',
            'in-reply-to': '<attach-cap-1@example.com>',
            'message-id': '<attach-cap-2@example.com>',
          },
          [file],
        ),
      );
      // 起票/追記自体は失敗しない (200 でスレッド追記として処理される)
      expect(reply.status).toBe(200);
      // コメント本体は保存されるが、添付は追加されない (既存 100 件のまま)
      const comments = [...store.comments.values()].filter((c) => c.ticketId === ticketId);
      expect(comments).toHaveLength(1);
      const attachments = [...store.attachments.values()].filter((a) => a.ticketId === ticketId);
      expect(attachments).toHaveLength(100);
      // 新しいファイルは storage にも書き込まれない
      expect(storage.entries.size).toBe(0);
    });
  });
});
