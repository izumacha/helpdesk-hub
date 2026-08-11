// 認証済みチケット書き込み 2 経路 (`POST /api/tickets` / `POST /api/tickets/[id]/comments`) の
// リクエストボディ上限の回帰防止。
//
// なぜ専用のテストファイルにするか:
//   - 既存の 2 ファイル (`create-ticket-with-files.test.ts` / `post-comment-route.test.ts`) は
//     末尾でレート制限 (ユーザー単位 60 秒 20 件) を意図的に使い切るテストを持つため、後ろに
//     テストを足すと 429 に巻き込まれる。独立したファイルなら実行順に依存しない。
//   - 上限そのものは「読み取りに到達する前/最中に打ち切る」性質で、添付の保存やロールバックとは
//     関心事が別 (あちらは検証を通った後の話)。
//
// 上限を撤去する (= `req.formData()` / `req.json()` を直接呼ぶ形へ戻す) と、ここが 413 ではなく
// 201 / 422 になって落ちる。

// Vitest の DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos/uow)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// メモリストレージ (添付バイナリ用。ここでは書き込みまで到達しないが依存の差し替えに必要)
import { createMemoryStorage, type MemoryStoragePort } from '@/data/adapters/memory/storage.memory';
// 型のみ
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
// レート制限の履歴をテスト間でクリアする内部用関数
import { __resetRateLimits } from '@/lib/rate-limit';
// 検証対象の上限値・制限時間 (route が参照するのと同じ定義を使う。片方だけ変えたら気付けるように)
import {
  ATTACHMENT_UPLOAD_BODY_TOTAL_TIMEOUT_MS,
  ATTACHMENT_UPLOAD_MAX_BODY_BYTES,
  TICKET_JSON_MAX_BODY_BYTES,
} from '@/lib/ticket-body-limits';
// 巻き添え回避用の無通信上限 (両経路が既定ではなくこちらを明示的に使う)
import { STALL_TOLERANT_BODY_IDLE_TIMEOUT_MS } from '@/lib/request-body-limit';
// 期待する文言も表そのものから引く (文言を書き写すと、表を変えたときにテストだけ古くなる)
import {
  TICKET_JSON_BODY_REJECT_MESSAGES,
  TICKET_MULTIPART_BODY_REJECT_MESSAGES,
} from '@/lib/ticket-body-reject-messages';

// テナントと起票者 (Lite モードの依頼者 1 人だけで足りる)
const TENANT = 'default-tenant';
const REQUESTER = 'u-req-1';

// 各テストで差し替える可変な依存 (route の import 前に値を入れる)
let store: Store;
let repos: Repos;
let uow: UnitOfWork;
let storage: MemoryStoragePort;

// 上限・制限時間は「ルートが引数で明示的に渡す」ことで初めて効く。渡し忘れると既定
// (無通信 10 秒 / 全体 120 秒) に黙って戻り、51MB の枠に対して時間が足りず正規のアップロードが
// 途中で打ち切られる。挙動テストでは既定値でも緑のままなので、引数そのものを表明する。
// 記録するのは第 2 引数以降 (上限と制限時間) だけ — 第 1 引数の Request まで記録すると
// 本文が mock.calls 経由でファイル終了まで参照され続ける (inbound-email-route.test.ts と同じ)
const { readFormSpy, readTextSpy } = vi.hoisted(() => ({
  readFormSpy: vi.fn(),
  readTextSpy: vi.fn(),
}));
vi.mock('@/lib/request-body-limit', async (importOriginal) => {
  // 本物の実装を読み込む (差し替えるのは「呼ばれ方の記録」だけで、中身は本物を通す)
  const actual = await importOriginal<typeof import('@/lib/request-body-limit')>();
  return {
    ...actual,
    // 引数を記録してから本物へ委譲する
    readFormWithinByteLimit: (...args: Parameters<typeof actual.readFormWithinByteLimit>) => {
      readFormSpy(...args.slice(1));
      return actual.readFormWithinByteLimit(...args);
    },
    readTextWithinByteLimit: (...args: Parameters<typeof actual.readTextWithinByteLimit>) => {
      readTextSpy(...args.slice(1));
      return actual.readTextWithinByteLimit(...args);
    },
  };
});

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

// セッションは依頼者で固定 (テナント Lite モード)
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: REQUESTER, role: 'requester' as const, tenantId: TENANT },
  }),
}));

// next/cache の副作用は不要 (コメント投稿が revalidatePath を呼ぶ)
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

// SSE ブロードキャスト経路も不要
vi.mock('@/lib/sse-subscribers', () => ({
  broadcast: vi.fn(),
}));

// テナント (Lite) + 依頼者 + その依頼者が起票したチケットを投入し、チケット ID を返す
async function seed(): Promise<string> {
  const now = new Date();
  // Lite モードのテナントを投入
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode: 'lite',
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    subscriptionPlan: 'free' as const,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
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
  // コメント投稿テスト用に、この依頼者が起票したチケットを 1 件作る
  const ticket = await repos.tickets.create({
    title: 'プリンタ',
    body: '紙詰まり',
    priority: 'Medium',
    creatorId: REQUESTER,
    categoryId: null,
    tenantId: TENANT,
  });
  return ticket.id;
}

// JPEG のマジックバイト (validateUploadedFiles の整合チェックを通すため必要)
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

// 小さな JPEG File を作る (上限テストでは中身の大きさは使わない — 申告サイズで弾くため)
function makeJpeg(name: string): File {
  return new File([new Uint8Array([...JPEG_MAGIC, ...new TextEncoder().encode('jpeg')])], name, {
    type: 'image/jpeg',
  });
}

/**
 * multipart のボディはそのままに、Content-Length だけを上限超過で申告した Request を作る。
 *
 * **実際に上限ぶん (51MB) のボディを組み立てない**のが要点: 申告値の事前検査は本文を 1 バイトも
 * 読まずに打ち切る一番安い経路で、そこが効いていれば「読み取りに到達する前に枠を見ている」ことは
 * 言える。51MB を毎回確保するとテストが重くなるだけで、追加で分かることは無い
 * (ストリーム側の累計バイト数による打ち切りは、枠が 128KB で軽い JSON 経路の方で確かめる)。
 */
async function buildOverDeclaredMultipartRequest(url: string, files: File[]): Promise<Request> {
  // まず通常の FormData リクエストを作り、undici が自動付与した boundary 付き Content-Type を得る
  const form = new FormData();
  form.set('title', 'タイトル');
  form.set('body', '本文');
  form.set('priority', 'Medium');
  for (const f of files) form.append('files', f, f.name);
  const base = new Request(url, { method: 'POST', body: form });
  // 組み立て済みの Content-Type (boundary 付き) と実ボディを取り出す
  const contentType = base.headers.get('content-type') ?? '';
  const bodyBuf = await base.arrayBuffer();
  // 同じボディに「上限 + 1 バイト」の Content-Length を付け直す (過大申告)
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'content-length': String(ATTACHMENT_UPLOAD_MAX_BODY_BYTES + 1),
      // isSameOriginRequest (CSRF 対策) を通過させる (実ブラウザの同一オリジン送信を模擬)
      'sec-fetch-site': 'same-origin',
    },
    body: bodyBuf,
  });
}

// JSON ボディの Request を作る (Request は文字列ボディに Content-Length を自動付与しないため、
// ストリームの累計バイト数による打ち切り = chunked 転送と同じ経路をそのまま再現できる)
function buildJsonRequest(payload: unknown): Request {
  return new Request('http://localhost/api/tickets', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  // 毎回新しい context / storage を作って独立な状態にする
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  uow = ctx.uow;
  storage = createMemoryStorage();
  // 動的 import の結果をリセット (mock 設定を反映させるため)
  vi.resetModules();
  // 他ファイル・他テストのレート制限履歴を持ち込まない (この経路は 60 秒 20 件で 429 になる)
  __resetRateLimits();
  // 引数の記録をテストごとにリセットする
  readFormSpy.mockClear();
  readTextSpy.mockClear();
});

describe('POST /api/tickets のボディ上限', () => {
  // 申告サイズが枠を超えていれば、本文を読まずに 413 で打ち切る。
  // 上限が無い実装 (req.formData() 直呼び) では申告を見ないので 201 になり、ここで落ちる
  it('multipart: Content-Length が上限超過なら 413 で拒否しチケットを作らない', async () => {
    await seed();
    const { POST } = await import('@/app/api/tickets/route');
    const req = await buildOverDeclaredMultipartRequest('http://localhost/api/tickets', [
      makeJpeg('a.jpg'),
    ]);

    const res = await POST(req);
    // サイズ超過は 413 (形式不正の 400 と区別できることが利用者への案内の前提)
    expect(res.status).toBe(413);
    // 文言は本番の表の 'too-large' そのもの (表の項目を入れ替える変更を検出する)
    expect(await res.json()).toEqual({ error: TICKET_MULTIPART_BODY_REJECT_MESSAGES['too-large'] });
    // 読み取りに到達していないのでチケットは 1 件も増えない (シードの 1 件だけ)
    expect(store.tickets.size).toBe(1);
  });

  // JSON 経路はストリームの累計バイト数で打ち切る (Content-Length の申告が無い場合の経路)。
  // 枠が multipart と同じ 51MB へ「統合」されると、この 200KB の本文が通ってしまい落ちる
  it('JSON: Content-Length が無くても実バイト数が上限超過なら 413 で拒否する', async () => {
    await seed();
    const { POST } = await import('@/app/api/tickets/route');
    // 枠を確実に超える長さの本文 (Zod の 10,000 文字上限も超えるが、判定はそれより手前で起きる)
    const oversizedBody = 'あ'.repeat(TICKET_JSON_MAX_BODY_BYTES); // 1 文字 3 バイトなので確実に超過
    const req = buildJsonRequest({ title: 't', body: oversizedBody, priority: 'Medium' });

    const res = await POST(req);
    // 上限で打ち切るので、Zod の 422 ではなく 413 になる (読む前に枠で弾いている証明)
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: TICKET_JSON_BODY_REJECT_MESSAGES['too-large'] });
    expect(store.tickets.size).toBe(1);
  });

  // 上限つき読み取りへ移しても、枠内の JSON 起票は従来どおり成功する
  // (req.json() → readTextWithinByteLimit + JSON.parse の差し替えで壊れていないことの表明)
  it('JSON: 枠内のボディは従来どおり 201 で起票される', async () => {
    await seed();
    const { POST } = await import('@/app/api/tickets/route');
    const req = buildJsonRequest({ title: '日本語のタイトル', body: '本文🖨️', priority: 'High' });

    const res = await POST(req);
    expect(res.status).toBe(201);
    // マルチバイト文字が化けずに保存されている (復号が崩れると別の文字列になる)
    const ticket = (await res.json()) as { title: string; body: string };
    expect(ticket.title).toBe('日本語のタイトル');
    expect(ticket.body).toBe('本文🖨️');
  });

  // 壊れた JSON は移行前と同じ 400 + 同じ文言 (上限の導入で形式不正の扱いを変えていない)
  it('JSON: 壊れたボディは 400 で拒否する', async () => {
    await seed();
    const { POST } = await import('@/app/api/tickets/route');
    const req = new Request('http://localhost/api/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: '{ not json',
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'リクエストの形式が正しくありません' });
  });
});

describe('読み取りヘルパーへ渡す上限と制限時間', () => {
  // multipart 経路: 51MB の枠に対して既定の全体期限 (120 秒) では足りないため専用の値を渡す。
  // 無通信は巻き添え回避用の 30 秒を明示的に使う (採用条件は request-body-limit.ts のコメント)
  it('multipart 起票はこの経路の上限・無通信上限・全体期限を渡している', async () => {
    await seed();
    const { POST } = await import('@/app/api/tickets/route');
    const form = new FormData();
    form.set('title', 't');
    form.set('body', 'b');
    form.set('priority', 'Medium');
    form.append('files', makeJpeg('a.jpg'), 'a.jpg');
    await POST(
      new Request('http://localhost/api/tickets', {
        method: 'POST',
        body: form,
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
    );

    expect(readFormSpy).toHaveBeenCalledTimes(1);
    expect(readFormSpy.mock.calls[0]).toEqual([
      ATTACHMENT_UPLOAD_MAX_BODY_BYTES,
      STALL_TOLERANT_BODY_IDLE_TIMEOUT_MS, // 巻き添え回避用の無通信上限を明示的に使う
      ATTACHMENT_UPLOAD_BODY_TOTAL_TIMEOUT_MS,
    ]);
  });

  // JSON 経路: 128KB は一瞬で送り切れるので全体期限は既定のまま (第 4 引数を渡さない)。
  // 無通信だけは multipart 側と同じ理由で巻き添え回避用の値を渡す
  it('JSON 起票は上限と無通信上限を渡し、全体期限は既定に任せている', async () => {
    await seed();
    const { POST } = await import('@/app/api/tickets/route');
    await POST(buildJsonRequest({ title: 't', body: 'b', priority: 'Medium' }));

    expect(readTextSpy).toHaveBeenCalledTimes(1);
    expect(readTextSpy.mock.calls[0]).toEqual([
      TICKET_JSON_MAX_BODY_BYTES,
      STALL_TOLERANT_BODY_IDLE_TIMEOUT_MS,
    ]);
  });

  // コメント投稿も新規起票の添付経路とまったく同じ 3 値を渡す (枠が同じなので時間も同じ)
  it('コメント投稿は新規起票の添付経路と同じ上限・制限時間を渡している', async () => {
    const ticketId = await seed();
    const { POST } = await import('@/app/api/tickets/[id]/comments/route');
    const form = new FormData();
    form.set('body', 'コメント');
    await POST(
      new Request(`http://localhost/api/tickets/${ticketId}/comments`, {
        method: 'POST',
        body: form,
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
      { params: Promise.resolve({ id: ticketId }) },
    );

    expect(readFormSpy).toHaveBeenCalledTimes(1);
    expect(readFormSpy.mock.calls[0]).toEqual([
      ATTACHMENT_UPLOAD_MAX_BODY_BYTES,
      STALL_TOLERANT_BODY_IDLE_TIMEOUT_MS,
      ATTACHMENT_UPLOAD_BODY_TOTAL_TIMEOUT_MS,
    ]);
  });
});

describe('POST /api/tickets/[id]/comments のボディ上限', () => {
  // 添付付きコメントも新規起票と同じ枠・同じ文言表を共有する
  it('Content-Length が上限超過なら 413 で拒否しコメントを作らない', async () => {
    const ticketId = await seed();
    const { POST } = await import('@/app/api/tickets/[id]/comments/route');
    const req = await buildOverDeclaredMultipartRequest(
      `http://localhost/api/tickets/${ticketId}/comments`,
      [makeJpeg('a.jpg')],
    );

    const res = await POST(req, { params: Promise.resolve({ id: ticketId }) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: TICKET_MULTIPART_BODY_REJECT_MESSAGES['too-large'] });
    // 読み取りに到達していないのでコメントは作られない
    expect(store.comments.size).toBe(0);
  });
});
