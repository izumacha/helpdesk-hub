// POST /api/inbound/line (Phase 2 LINE 取り込み) の Route Handler テスト。
// 署名検証済みの本文を渡し、(a) ワンタイムコード送信での連携 (起票しない)、
// (b) 連携済みユーザーの起票者が本人になる、(c) 未連携はプロキシ担当者、を検証する (DB は持ち込まない)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
import { hashLineLinkCode, normalizeLineLinkCode } from '@/lib/line-link';
// レート制限バケットをテスト間で初期化するためのヘルパー (グローバル Map の汚染を防ぐ)
import { __resetRateLimits } from '@/lib/rate-limit';

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
// 上書きする)。Pro プランは現状無制限 (Infinity) のため、実際のプラン設定だけでは
// 上限到達を再現できず、この関数の呼び出し配線自体を検証する必要があるため
const { getMonthlyTicketQuotaMock } = vi.hoisted(() => ({
  getMonthlyTicketQuotaMock: vi.fn(),
}));
vi.mock('@/lib/tenant-plan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tenant-plan')>();
  getMonthlyTicketQuotaMock.mockImplementation(actual.getMonthlyTicketQuota);
  return { ...actual, getMonthlyTicketQuota: getMonthlyTicketQuotaMock };
});

const SECRET = 'test-line-channel-secret';
const TENANT = 'default-tenant';
const AGENT_ID = 'u-agent-1';
const MEMBER_ID = 'u-member-1';
// このテナントのチャネルを表す Bot User ID (LINE の destination フィールドと一致させる値)
const BOT_USER_ID = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
// LINE ユーザー ID のテスト用固定値。LINE の実形式 (U + 32桁小文字 hex) に合わせる。
// ルートが userId フォーマットを検証するようになったため、形式外の値は '不明' 扱いになる
const LINE_ID_UNLINKED = 'U00000000000000000000000000000001'; // テナントメンバーに未紐付け
const LINE_ID_LINKED = 'U00000000000000000000000000000002'; // MEMBER_ID に紐付け済み
const LINE_ID_NEW = 'U00000000000000000000000000000003'; // 新規連携対象

let store: Store;
let repos: Repos;
let uow: UnitOfWork;

// @/data を差し替え (getter で beforeEach の上書きを反映)。
// ルートは冪等な起票を uow.run (Serializable トランザクション) で行うため uow も必要
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
  get uow() {
    return uow;
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
    // LINE 連携は Pro 以上でのみ利用可能 (§6.1) なので、既定シードは Pro にする
    subscriptionPlan: 'pro' as const,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
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
  // テナント単位の LINE 連携設定 (destination=BOT_USER_ID からこのテナントを解決する)
  store.lineConfigs.set('line_cfg_1', {
    id: 'line_cfg_1',
    tenantId: TENANT,
    channelSecret: SECRET,
    channelAccessToken: 'test-access-token',
    botUserId: BOT_USER_ID,
    createdAt: now,
    updatedAt: now,
  });
}

// LINE 署名を計算する (X-Line-Signature = Base64(HMAC-SHA256(body, secret)))
function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body, 'utf8').digest('base64');
}

// 1 件のテキストメッセージイベントを含む署名付きリクエストを組み立てる。
// destination はチャネル解決に使う値で、既定はシード済みテナントの BOT_USER_ID
function makeRequest(
  text: string,
  userId: string,
  destination: string = BOT_USER_ID,
  messageId: string = 'm1',
): Request {
  const body = JSON.stringify({
    destination,
    events: [
      {
        type: 'message',
        source: { type: 'user', userId },
        message: { type: 'text', id: messageId, text },
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
    uow = ctx.uow;
    seed();
    // レート制限バケットはモジュールグローバルなので、他ファイルのテストの影響を受けないよう初期化する
    __resetRateLimits();
    // 連携コード冪等化は DB (lineLinkCodeRefs) 永続化に切り替わったため、createMemoryContext() で
    // 毎回新しい空ストアが作られる時点で自動的に初期化される (グローバル Map のリセットは不要)
  });

  afterEach(() => {
    // 次のテストファイルに影響しないよう、このファイルで消費したバケットも初期化しておく
    __resetRateLimits();
  });

  // セキュリティ回帰テスト: destination (署名検証前の値) をレート制限のキーに使うと、
  // 攻撃者が destination を毎回変えるだけで無制限に新しいバケットを作れてしまい、
  // レート制限が事実上機能しなくなる。固定キーの全体レート制限がこれを防いでいることを確認する。
  it('destination を変え続けても固定キーの全体レート制限で頭打ちになる (レート制限回避の防止)', async () => {
    const { POST } = await import('@/app/api/inbound/line/route');
    // LINE_UNAUTHENTICATED_RATE_LIMIT の上限 (600件/分) に達するまで、
    // 毎回異なる未登録 destination で送り続ける (署名は無効なので全て 401 になるはず)
    let lastStatus = 0;
    for (let i = 0; i < 601; i += 1) {
      // 16進32桁のランダムな destination を都度生成する (登録済み BOT_USER_ID とは無関係)
      const randomDestination = `U${i.toString(16).padStart(32, '0')}`;
      const body = JSON.stringify({ destination: randomDestination, events: [] });
      const req = new Request('http://localhost/api/inbound/line', {
        method: 'POST',
        // 署名はこの destination 用のチャネル設定が無いのでどうせ無効 (未登録チャネル判定になる)
        headers: { 'content-type': 'application/json', 'x-line-signature': 'invalid-signature' },
        body,
      });
      const res = await POST(req);
      lastStatus = res.status;
    }
    // 601 回目 (上限 600 を超えた直後) は、destination が変わっていても固定キーの
    // 全体レート制限に引っかかり 429 になる (401 のままなら回避が成立してしまっている)
    expect(lastStatus).toBe(429);
  });

  // Standard 以下のプランは LINE 連携不可 (§6.1 料金プラン)。署名は正しくても起票しない
  it('Pro 未満のプランのテナントは起票せず 200 (プランゲート)', async () => {
    // シード済みテナントを Standard プランに書き換える
    store.tenants.set(TENANT, {
      ...store.tenants.get(TENANT)!,
      subscriptionPlan: 'standard' as const,
    });
    const { POST } = await import('@/app/api/inbound/line/route');
    const res = await POST(makeRequest('プリンターが動きません', LINE_ID_UNLINKED));
    expect(res.status).toBe(200);
    expect(store.tickets.size).toBe(0);
  });

  // 未連携ユーザーの通常メッセージはプロキシ担当者を起票者にして起票する
  it('未連携ユーザーのメッセージはプロキシ担当者で起票する', async () => {
    const { POST } = await import('@/app/api/inbound/line/route');
    // LINE_ID_UNLINKED はテナントメンバーに紐付いていないため、プロキシ担当者が起票者になる
    const res = await POST(makeRequest('プリンターが動きません', LINE_ID_UNLINKED));
    expect(res.status).toBe(200);
    expect(store.tickets.size).toBe(1);
    const ticket = Array.from(store.tickets.values())[0];
    // 未連携なので起票者はプロキシ担当者
    expect(ticket.creatorId).toBe(AGENT_ID);
    // 回帰防止: firstResponseDueAt が配線されておらず常に null のまま起票される不備があった
    expect(ticket.firstResponseDueAt).not.toBeNull();
  });

  // 連携済みユーザーのメッセージは本人を起票者にする (自己解決 UI 開通)
  it('連携済みユーザーのメッセージは本人を起票者にする', async () => {
    // LINE_ID_LINKED を MEMBER_ID に連携済みにしておく
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
      lineUserId: LINE_ID_LINKED, // 正規 LINE 形式 (U + 32桁 hex) の紐付け済み ID
    });
    const { POST } = await import('@/app/api/inbound/line/route');
    const res = await POST(makeRequest('パソコンが重いです', LINE_ID_LINKED));
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
    const res = await POST(makeRequest('ab7k9qf2', LINE_ID_NEW));
    expect(res.status).toBe(200);
    // 連携が成立し、チケットは作られない
    expect(store.tickets.size).toBe(0);
    // 紐付け済みの lineUserId は正規形式の ID になっている
    expect(store.users.get(MEMBER_ID)?.lineUserId).toBe(LINE_ID_NEW);
    // 発行中コードは消費済み
    expect(store.users.get(MEMBER_ID)?.lineLinkCodeHash).toBeNull();
  });

  // 回帰防止: 連携成功直後に Webhook 応答が遅延して LINE が同一メッセージを再送すると、
  // 2 回目はコードが既に消費済み (invalid) になり、コード文字列そのものが本文の問い合わせ
  // として誤起票され得た (既知の制約として明記されていたエッジケース)。
  // 同一 messageId の連携コード処理は冪等化され、再送では起票されないことを確認する。
  it('連携コード成功後の同一メッセージ ID 再送では誤起票しない', async () => {
    const now = new Date();
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
    // 1 回目: 連携が成立し、コードが消費される (チケットは作られない)
    const req = () => makeRequest('ab7k9qf2', LINE_ID_NEW);
    const first = await POST(req());
    expect(first.status).toBe(200);
    expect(store.tickets.size).toBe(0);
    expect(store.users.get(MEMBER_ID)?.lineUserId).toBe(LINE_ID_NEW);

    // 2 回目: 同一 messageId ('m1') の再送 (LINE の at-least-once 再送を模す)。
    // 冪等化が無ければコードが消費済みで invalid 判定になり、"ab7k9qf2" が本文の問い合わせとして
    // 誤起票されてしまう。冪等化により再送はスキップされ、チケットは作られない。
    const second = await POST(req());
    expect(second.status).toBe(200);
    expect(store.tickets.size).toBe(0);
  });

  // 回帰防止 (/code-review ultra 指摘対応): 連携コード処理の冪等化記録が DB 永続化
  // (lineLinkCodeRefs) されていること。旧インプロセス Map 実装は TTL (10分) 経過後に
  // エントリを掃除していたため、TTL 経過後にプロセス再起動/デプロイが挟まらなくても、
  // 長時間後の再送では冪等化が効かず「コードは消費済み → invalid → 誤起票」が再現し得た。
  // DB 永続化では TTL を持たないため、長時間経過後の再送でも確実にスキップされることを確認する。
  it('連携コード処理は長時間経過後の再送でも冪等化により誤起票されない', async () => {
    const rawCode = 'A1B2C3D0';
    const codeHash = await hashLineLinkCode(normalizeLineLinkCode(rawCode));
    const now = new Date();
    store.users.set('u-member-0', {
      id: 'u-member-0',
      email: 'member0@example.com',
      name: '会員0',
      passwordHash: 'x',
      role: 'requester',
      tenantId: TENANT,
      createdAt: now,
      updatedAt: now,
      lineLinkCodeHash: codeHash,
      lineLinkCodeExpiresAt: new Date(Date.now() + 3_600_000),
    });
    const { POST } = await import('@/app/api/inbound/line/route');
    const messageId = 'link-resend-test';
    const lineUserId = `U${'1'.repeat(32)}`;

    // 1 回目: 連携が成功する (起票は伴わない)
    const first = await POST(makeRequest(rawCode, lineUserId, BOT_USER_ID, messageId));
    expect(first.status).toBe(200);
    expect(store.tickets.size).toBe(0);
    // 処理済みとして DB に永続化されていること
    expect(store.lineLinkCodeRefs.has(messageId)).toBe(true);

    // 旧 TTL (10分) を大幅に超える期間が経過しても、DB 永続化なら記録は消えない
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000)); // 24時間後

      // 2 回目 (同一 messageId の再送): コードは既に消費済みなので、DB 永続化された
      // 冪等化が無ければコード文字列がそのまま問い合わせ本文として誤起票されてしまう
      const second = await POST(makeRequest(rawCode, lineUserId, BOT_USER_ID, messageId));
      expect(second.status).toBe(200);
      // 誤起票されていないこと (これが本テストの主眼)
      expect(store.tickets.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // コードの形だが発行行が無いテキストは通常の問い合わせとして起票する
  it('コード形だが未発行のテキストは通常起票する', async () => {
    const { POST } = await import('@/app/api/inbound/line/route');
    // looksLike を満たす 8 文字だが発行行が無い
    const res = await POST(makeRequest('ZZ112233', LINE_ID_UNLINKED));
    expect(res.status).toBe(200);
    // 連携ではなく通常起票になる
    expect(store.tickets.size).toBe(1);
    expect(Array.from(store.tickets.values())[0].creatorId).toBe(AGENT_ID);
  });

  // 同じメッセージ ID を含む Webhook が再送されても、二重にチケットを起票しない (冪等化)
  it('同じ LINE メッセージ ID の再送では重複起票しない', async () => {
    const { POST } = await import('@/app/api/inbound/line/route');
    // 1 回目: 通常どおり起票される
    const first = await POST(makeRequest('プリンターが動きません', LINE_ID_UNLINKED));
    expect(first.status).toBe(200);
    expect(store.tickets.size).toBe(1);
    const firstTicketId = Array.from(store.tickets.values())[0]!.id;

    // 2 回目: 同じ message.id ('m1') を含む同一リクエストを再送する (LINE の at-least-once 再送を模す)
    const second = await POST(makeRequest('プリンターが動きません', LINE_ID_UNLINKED));
    expect(second.status).toBe(200);
    // チケットは増えない (二重起票していない)
    expect(store.tickets.size).toBe(1);
    // レスポンスには既存チケット ID がそのまま返る
    const secondBody = (await second.json()) as { ticketIds: string[] };
    expect(secondBody.ticketIds).toEqual([firstTicketId]);
  });

  // 書き込み競合 (Serializable 分離レベルでの中断) が起きても、対応表を読み直して
  // 重複扱いにし、二重にチケットを作らないことを確認する。
  // 実際の Postgres での競合は tests/data/line-message-repository.contract.prisma.test.ts
  // (RUN_PRISMA_CONTRACT=1 が必要) で検証し、ここでは createLineTicketIdempotent の
  // エラーハンドリング分岐 (uow.isTransactionConflict → 対応表の再読込) を検証する。
  it('書き込み競合が起きても対応表を読み直して重複扱いにする (二重起票しない)', async () => {
    // 「別リクエストが先に確定させた」チケットをあらかじめ用意しておく
    const winnerTicket = await repos.tickets.create({
      title: '先勝ちリクエストが作成',
      body: '本文',
      priority: 'Medium',
      categoryId: null,
      creatorId: AGENT_ID,
      tenantId: TENANT,
    });

    // findTicketIdByMessageId: 1 回目 (事前チェック) は null、2 回目以降 (競合後の再確認) は
    // 先勝ちチケット ID を返す。「事前チェックの時点では未処理だったが、その後 (このリクエストの
    // トランザクションが競合で中断される間に) 別リクエストが確定させた」という順序を再現する
    const findTicketIdByMessageId = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(winnerTicket.id);
    repos = {
      ...repos,
      lineMessages: { ...repos.lineMessages, findTicketIdByMessageId },
    };

    // uow.run を「書き込み競合で必ず失敗する」実装に差し替える
    const conflictError = new Error('simulated write conflict');
    uow = {
      run: vi.fn(async () => {
        throw conflictError;
      }),
      isTransactionConflict: (err) => err === conflictError,
    };

    const { POST } = await import('@/app/api/inbound/line/route');
    const res = await POST(makeRequest('プリンターが動きません', LINE_ID_UNLINKED));
    expect(res.status).toBe(200);
    // 新規チケットは作られず、先勝ちの 1 件のままであること
    expect(store.tickets.size).toBe(1);
    const body = (await res.json()) as { ticketIds: string[] };
    expect(body.ticketIds).toEqual([winnerTicket.id]);
    // 事前チェック + 競合後の再確認の 2 回、対応表が引かれている
    expect(findTicketIdByMessageId).toHaveBeenCalledTimes(2);
  });

  // 署名が不正なリクエストは 401 で拒否する (destination は登録済みチャネルと一致させ、
  // 「チャネル未登録」ではなく「署名不一致」の分岐を確実に踏む)
  it('署名が不正なら 401 を返す', async () => {
    const body = JSON.stringify({ destination: BOT_USER_ID, events: [] });
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

  // destination が未登録のチャネルを指す場合も 401 で拒否する (署名は正当な値で計算するが、
  // どのテナントの鍵で検証すべきか分からないため署名検証まで到達しない)
  it('destination が未登録のチャネルなら 401 を返す', async () => {
    const unknownDestination = 'Uccccccccccccccccccccccccccccccc';
    const body = JSON.stringify({
      destination: unknownDestination,
      events: [
        {
          type: 'message',
          source: { type: 'user', userId: LINE_ID_UNLINKED },
          message: { type: 'text', id: 'm1', text: 'プリンターが動きません' },
        },
      ],
    });
    // このチャネルの正しいシークレットが無いので、SECRET で署名しても一致しないテナントに届く想定
    const req = new Request('http://localhost/api/inbound/line', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-line-signature': sign(body) },
      body,
    });
    const { POST } = await import('@/app/api/inbound/line/route');
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(store.tickets.size).toBe(0);
  });

  // 回帰防止: 新規起票を Slack/Teams/Chatwork の外部チャネルへ通知する (Web フォーム/メール/CSV と共有)。
  // 従来は Web フォーム (POST /api/tickets) にしか配線されておらず、LINE 経由の起票は
  // 担当者チームの Slack に気づかれないまま埋もれてしまっていた。
  describe('外部通知 (Slack/Teams/Chatwork)', () => {
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
      const tenant = store.tenants.get(TENANT)!;
      store.tenants.set(TENANT, { ...tenant, slackWebhookUrl: SLACK_WEBHOOK_URL });

      const { POST } = await import('@/app/api/inbound/line/route');
      const res = await POST(makeRequest('プリンターが動きません', LINE_ID_UNLINKED));
      expect(res.status).toBe(200);
      expect(store.tickets.size).toBe(1);

      // Slack Webhook へ 1 回だけ POST される
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(SLACK_WEBHOOK_URL);
      expect(JSON.stringify(JSON.parse(init.body))).toContain('プリンターが動きません');
    });

    it('外部通知が未設定のテナントで新規起票しても fetch は呼ばれない', async () => {
      const { POST } = await import('@/app/api/inbound/line/route');
      const res = await POST(makeRequest('プリンターが動きません', LINE_ID_UNLINKED));
      expect(res.status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // ワンタイムコードでの連携処理は起票を伴わないため、新規起票向け外部通知も送らない
    it('ワンタイムコードでの連携処理では外部通知を送らない', async () => {
      const tenant = store.tenants.get(TENANT)!;
      store.tenants.set(TENANT, { ...tenant, slackWebhookUrl: SLACK_WEBHOOK_URL });
      // 有効な連携コードを発行しておく
      const now = new Date();
      const rawCode = 'ABCD1234';
      const codeHash = await hashLineLinkCode(normalizeLineLinkCode(rawCode));
      store.users.set(MEMBER_ID, {
        id: MEMBER_ID,
        email: 'member@example.com',
        name: '会員 花子',
        passwordHash: 'x',
        role: 'requester',
        tenantId: TENANT,
        createdAt: now,
        updatedAt: now,
        lineLinkCodeHash: codeHash,
        lineLinkCodeExpiresAt: new Date(Date.now() + 60_000),
      });

      const { POST } = await import('@/app/api/inbound/line/route');
      const res = await POST(makeRequest(rawCode, LINE_ID_NEW));
      expect(res.status).toBe(200);
      expect(store.tickets.size).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // 回帰防止: 月間チケット上限 (§6.1 料金プラン)。Web フォーム・CSV インポート・メール取り込みと
  // 共有する getMonthlyTicketQuota が、LINE 取り込みからも呼ばれることを確認する。
  // Pro プランは現状無制限のため、この関数自体をモックして上限到達を再現する。
  describe('月間チケット上限 (§6.1 料金プラン)', () => {
    it('上限到達済みなら起票せず 200 を返す', async () => {
      getMonthlyTicketQuotaMock.mockResolvedValueOnce({ limited: true, limit: 10, remaining: 0 });
      const { POST } = await import('@/app/api/inbound/line/route');
      const res = await POST(makeRequest('プリンターが動きません', LINE_ID_UNLINKED));
      expect(res.status).toBe(200);
      expect(store.tickets.size).toBe(0);
    });

    it('残枠があれば通常どおり起票する', async () => {
      getMonthlyTicketQuotaMock.mockResolvedValueOnce({ limited: true, limit: 10, remaining: 3 });
      const { POST } = await import('@/app/api/inbound/line/route');
      const res = await POST(makeRequest('プリンターが動きません', LINE_ID_UNLINKED));
      expect(res.status).toBe(200);
      expect(store.tickets.size).toBe(1);
    });
  });
});
