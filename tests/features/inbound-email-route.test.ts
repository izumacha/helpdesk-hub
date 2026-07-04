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
});
