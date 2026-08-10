// POST /api/webhooks/stripe (Phase 4 課金 Webhook) のテスト。
// Stripe 署名検証・Stripe クライアントは @/lib/stripe をモックして回避し、
// テナントのプラン更新と、ダウングレード時に Pro モードを強制解除する挙動を検証する (DB は持ち込まない)。
//
// 検証の背景: 以前は subscriptionPlan だけを更新し tenant.mode は変更していなかったため、
// Pro モードで運用していたテナントが解約/ダウングレードしても mode='pro' のまま残り、
// エスカレーション等の Pro 専用機能が使い続けられてしまう不備があった。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
// システムアクター (actorId=null) の表示名。ハードコードせず一元管理定数と突き合わせる
import { SETTINGS_AUDIT_SYSTEM_ACTOR_NAME } from '@/lib/constants';
// ボディサイズの上限。ルートと同じ定義を参照する (#287。片方だけ値を変えたら気付けるように)
import { STRIPE_WEBHOOK_MAX_BODY_BYTES } from '@/lib/webhook-body-limits';

const TENANT = 'default-tenant';

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

// Stripe SDK 呼び出し (署名検証・Price ID→プラン判定) をモックする。
// vi.hoisted で先に用意することで、vi.mock のファクトリから参照できるようにする (巻き上げ順序対策)。
// planForNextCall でテストごとに「今回のイベントで判定させたいプラン」を差し替える。
// constructEventSpy は #287 の移行 (req.text() → readBodyWithinByteLimit + TextDecoder) で
// 「署名検証へ渡る生ボディ」が変わっていないことを検証するために呼び出しを記録する
const { planForNextCall, constructEventSpy } = vi.hoisted(() => ({
  planForNextCall: { current: 'pro' as 'free' | 'standard' | 'pro' },
  constructEventSpy: vi.fn((rawBody: string) => JSON.parse(rawBody) as unknown),
}));
vi.mock('@/lib/stripe', () => ({
  // 署名検証はモックし、リクエストボディの JSON をそのまま Stripe イベントとして扱う
  getStripeClient: () => ({
    webhooks: {
      constructEvent: constructEventSpy,
    },
  }),
  getStripeWebhookSecret: () => 'whsec_test',
  // 本来は status + priceId から判定するが、テストでは明示的に差し替えて挙動を固定する
  stripeStatusToPlan: () => planForNextCall.current,
}));

// テナントをシードする (mode / plan を指定可能)。stripeEventProcessedAt は配信順序 CAS の
// テストで「既にこの時刻のイベントまで適用済み」を再現するために使う (省略時は未処理 = null)
function seedTenant(
  mode: 'lite' | 'pro',
  plan: 'free' | 'standard' | 'pro' | 'enterprise',
  stripeEventProcessedAt: Date | null = null,
): void {
  const now = new Date();
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode,
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    subscriptionPlan: plan,
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    stripeSubscriptionStatus: 'active',
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    stripeEventProcessedAt,
    createdAt: now,
  });
}

// Stripe イベント JSON + 署名ヘッダ (値は何でもよい。constructEvent はモック済み) を組み立てる。
// created (イベント自体の発生時刻。Unix 秒) は実際の Stripe イベントに必ず含まれるフィールドの
// ため、個別テストが明示指定しない限り「現在時刻」を既定値として補う (配信順序 CAS のテストは
// eventBody 側で created を明示的に上書きする)
function makeRequest(eventBody: Record<string, unknown>): Request {
  return new Request('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
    body: JSON.stringify({ created: Math.floor(Date.now() / 1000), ...eventBody }),
  });
}

describe('POST /api/webhooks/stripe', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    uow = ctx.uow;
    planForNextCall.current = 'pro';
    // 呼び出し記録をテストごとに初期化する (mockClear は実装を残したまま履歴だけ消す)
    constructEventSpy.mockClear();
  });

  // 解約 (customer.subscription.deleted) で Pro → Free に降格すると、Pro モードも強制的に lite へ戻る
  it('Pro テナントが解約されると Free に降格し、mode も lite に戻す', async () => {
    seedTenant('pro', 'pro');
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      makeRequest({
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'canceled',
            metadata: { tenantId: TENANT },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const tenant = store.tenants.get(TENANT)!;
    expect(tenant.subscriptionPlan).toBe('free');
    expect(tenant.mode).toBe('lite');
    // §4.3 フォローアップ: 自動ダウングレードによる mode 強制変更も監査ログに残ること
    // (actorId は操作したユーザーが存在しないため null = システムアクター)。
    // フォローアップ (2026-07-13): プラン自体の変更 (pro→free) も別エントリとして記録されること
    const auditLogs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT });
    expect(auditLogs).toHaveLength(2);
    const actions = auditLogs.map((l) => l.action).sort();
    expect(actions).toEqual(['subscription_plan_update', 'tenant_mode_update']);
    for (const log of auditLogs) {
      expect(log.actorId).toBeNull();
      expect(log.actorName).toBe(SETTINGS_AUDIT_SYSTEM_ACTOR_NAME);
    }
  });

  // 更新イベント (customer.subscription.updated) で Pro → Standard にダウングレードしても同様
  it('Pro テナントが Standard にダウングレードされると mode も lite に戻す', async () => {
    seedTenant('pro', 'pro');
    planForNextCall.current = 'standard';
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      makeRequest({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'active',
            items: { data: [{ price: { id: 'price_standard' } }] },
            metadata: { tenantId: TENANT },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const tenant = store.tenants.get(TENANT)!;
    expect(tenant.subscriptionPlan).toBe('standard');
    expect(tenant.mode).toBe('lite');
    // フォローアップ (2026-07-13): mode 強制変更に加え、プラン変更 (pro→standard) も記録される
    const auditLogs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT });
    expect(auditLogs.map((l) => l.action).sort()).toEqual([
      'subscription_plan_update',
      'tenant_mode_update',
    ]);
  });

  // Pro のまま更新される (昇格/継続) 場合は mode を変更しない
  it('Pro のまま更新されるときは mode を変更しない', async () => {
    seedTenant('pro', 'pro');
    planForNextCall.current = 'pro';
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      makeRequest({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'active',
            items: { data: [{ price: { id: 'price_pro' } }] },
            metadata: { tenantId: TENANT },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const tenant = store.tenants.get(TENANT)!;
    expect(tenant.subscriptionPlan).toBe('pro');
    expect(tenant.mode).toBe('pro');
    // mode が変わっていないので監査ログも記録されない (無関係なイベントで監査ログを埋めない)
    expect(await repos.settingsAudit.findAllByTenant({ tenantId: TENANT })).toHaveLength(0);
  });

  // 既に Lite モードのテナントがダウングレードしても、mode は変更不要 (既に lite) のまま
  it('Lite モードのテナントがダウングレードしても mode はそのまま', async () => {
    seedTenant('lite', 'standard');
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      makeRequest({
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'canceled',
            metadata: { tenantId: TENANT },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const tenant = store.tenants.get(TENANT)!;
    expect(tenant.subscriptionPlan).toBe('free');
    expect(tenant.mode).toBe('lite');
    // フォローアップ (2026-07-13): mode は既に lite のため tenant_mode_update は記録されないが、
    // プラン自体は standard→free に変わっているため subscription_plan_update は記録される
    const auditLogs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('subscription_plan_update');
  });

  // Enterprise は Stripe 管理外: 解約イベントが来てもプランを降格せず、mode も変更しない
  it('Enterprise テナントは解約イベントでもプランを降格せず mode も変更しない', async () => {
    seedTenant('pro', 'enterprise');
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      makeRequest({
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'canceled',
            metadata: { tenantId: TENANT },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const tenant = store.tenants.get(TENANT)!;
    expect(tenant.subscriptionPlan).toBe('enterprise');
    expect(tenant.mode).toBe('pro');
    // フォローアップ (2026-07-13): プランも mode も変化していないので監査ログは記録されない
    // (無関係なイベントで監査ログを埋めない)
    expect(await repos.settingsAudit.findAllByTenant({ tenantId: TENANT })).toHaveLength(0);
  });

  // フォローアップ (監査で発見したギャップ 2026-07-20): Stripe は Webhook イベントの配信順序を
  // 保証しない。既に新しいイベント (例: 解約 canceled) を適用済みのテナントに、ネットワーク遅延で
  // 後から届いた古いイベント (例: それより前の active への更新) を適用すると、最新の解約状態を
  // 巻き戻してしまう。古いイベントは無視され、現在の状態 (プラン・mode) が変わらないことを確認する
  it('保存済みより古い event.created の更新イベントは無視され状態が巻き戻らない', async () => {
    // 「直近 10 分前のイベントまで適用済み」のテナントを用意する (現在 free/lite = 解約済み相当)
    const processedAt = new Date();
    seedTenant('lite', 'free', processedAt);
    // このイベントは 1 時間前 (=保存済みより古い) に発生した「pro へのアップグレード」イベントとして届く
    const staleEventCreatedAt = Math.floor((processedAt.getTime() - 60 * 60 * 1000) / 1000);
    planForNextCall.current = 'pro';
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      makeRequest({
        created: staleEventCreatedAt,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'active',
            items: { data: [{ price: { id: 'price_pro' } }] },
            metadata: { tenantId: TENANT },
          },
        },
      }),
    );
    // Stripe には 200 を返す (エラーではなく意図的な無視。再送させない)
    expect(res.status).toBe(200);
    const tenant = store.tenants.get(TENANT)!;
    // 古いイベントは無視され、free/lite のまま (pro に巻き戻らない)
    expect(tenant.subscriptionPlan).toBe('free');
    expect(tenant.mode).toBe('lite');
    // 無視されたイベントは「変更」ではないため監査ログにも残らない
    expect(await repos.settingsAudit.findAllByTenant({ tenantId: TENANT })).toHaveLength(0);
  });

  // 保存済みより新しい event.created のイベントは通常どおり適用され、
  // 適用後の stripeEventProcessedAt がそのイベントの発生時刻に更新される
  it('保存済みより新しい event.created の更新イベントは通常どおり適用される', async () => {
    // 「1 時間前のイベントまで適用済み」のテナントを用意する
    const oldProcessedAt = new Date(Date.now() - 60 * 60 * 1000);
    seedTenant('pro', 'pro', oldProcessedAt);
    // このイベントは「今」発生した解約イベントとして届く (保存済みより新しい)
    const newEventCreatedAtSec = Math.floor(Date.now() / 1000);
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      makeRequest({
        created: newEventCreatedAtSec,
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'canceled',
            metadata: { tenantId: TENANT },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const tenant = store.tenants.get(TENANT)!;
    // 新しいイベントなので通常どおり反映される
    expect(tenant.subscriptionPlan).toBe('free');
    expect(tenant.mode).toBe('lite');
    // 適用済みイベント時刻が今回のイベントの発生時刻に更新されている
    expect(tenant.stripeEventProcessedAt?.getTime()).toBe(newEventCreatedAtSec * 1000);
  });

  // #287: ボディの読み取りを readBodyWithinByteLimit に寄せても、署名検証へ渡る文字列が
  // 移行前 (request.text()) と 1 バイトも変わらないことを固定する。
  // 読み取り方法の変更は署名検証の回帰に直結する (デコードや切り詰めが 1 箇所でも挟まると
  // 正規の Stripe イベントが全て検証失敗になり、課金状態の反映が丸ごと止まる) ため、
  // マルチバイト文字を含む本文で「受信した本文そのもの」が渡ることを表明する
  it('署名検証には受信した本文がそのまま渡る (マルチバイト文字を含んでも一致する)', async () => {
    seedTenant('lite', 'free');
    // 日本語 + 絵文字 (サロゲートペア) を含めて、UTF-8 の復号・再エンコードが挟まっても
    // 壊れないことを確かめる (壊れると実運用では HMAC 不一致 = 全イベント拒否になる)
    const body = JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          items: { data: [{ price: { id: 'price_pro' } }] },
          // Stripe の metadata は任意の文字列を持てるので、多バイト文字の混入は現実にあり得る
          metadata: { tenantId: TENANT, memo: '日本語のメモ🚀' },
        },
      },
    });
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      new Request('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
        body,
      }),
    );
    // イベントとして処理されている (= 復元した本文が JSON として壊れていない)
    expect(res.status).toBe(200);
    // 署名検証へ渡った第 1 引数が、送信した本文と完全一致する (これが崩れると HMAC が不一致になる)
    expect(constructEventSpy).toHaveBeenCalledTimes(1);
    expect(constructEventSpy.mock.calls[0]![0]).toBe(body);
    // 署名検証の先まで進み、プラン反映まで到達している
    expect(store.tenants.get(TENANT)!.subscriptionPlan).toBe('pro');
  });

  // 署名ヘッダが無いリクエストは 400 で拒否する (なりすまし対策)
  it('stripe-signature ヘッダが無ければ 400 を返す', async () => {
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const req = new Request('http://localhost/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'customer.subscription.deleted', data: { object: {} } }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

// #287: この経路は以前サイズ検査そのものが無く、未認証で到達できるうえに署名検証より前に
// ボディ全体がメモリへ展開されていた。上限が実際に効いていることを、
// 「署名検証 (constructEvent) まで到達したか」で表明する
// (上限を撤去すると本文がそのまま検証へ渡って 200 になり、これらのテストが落ちる)。
describe('POST /api/webhooks/stripe のリクエストサイズ上限', () => {
  // ちょうど指定バイト数になる Stripe イベント JSON を組み立てる。
  // metadata の padding フィールドで長さを詰める (詰める文字は ASCII なので 1 文字 = 1 バイト)。
  // 長さは必ず UTF-8 のバイト数で測る (土台に非 ASCII が混ざったときに境界値がずれないように)
  function eventBodyOfExactly(totalBytes: number): string {
    // まず padding 無しで組み立てて、目標との差分を padding の長さにする
    const build = (padding: string) =>
      JSON.stringify({
        created: 1_700_000_000,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'active',
            items: { data: [{ price: { id: 'price_pro' } }] },
            metadata: { tenantId: TENANT, padding },
          },
        },
      });
    // 目標バイト数から「padding が空のときのバイト数」を引いた分だけ詰める
    return build('A'.repeat(totalBytes - Buffer.byteLength(build(''), 'utf8')));
  }

  // 上限つきの POST を実行する共通処理 (Content-Length を明示したい場合はヘッダで渡す)
  async function postStripe(body: string, headers: Record<string, string> = {}) {
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    return POST(
      new Request('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': 'sig', ...headers },
        body,
      }),
    );
  }

  beforeEach(() => {
    // この describe だけを -t で絞って実行しても成立するよう、依存の初期化はここでも行う
    // (他の describe の beforeEach が動いた副作用に相乗りしない)
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    uow = ctx.uow;
    planForNextCall.current = 'pro';
    constructEventSpy.mockClear();
    seedTenant('lite', 'free');
  });

  // ヘッダの申告だけで上限超過と分かる場合は、本文を読まずに打ち切る。
  // 本文自体は上限内なので、実バイト数の検査だけならすり抜けてしまう
  it('Content-Length ヘッダが上限超過なら本文を読まずに 413 で拒否する', async () => {
    const res = await postStripe(eventBodyOfExactly(1024), {
      'content-length': String(STRIPE_WEBHOOK_MAX_BODY_BYTES + 1), // 申告だけ超過
    });
    expect(res.status).toBe(413);
    // 文言はこの経路の文言表から理由 'too-large' で引いたもの。ステータスで文言を選ぶ実装や、
    // 文言表の項目を入れ替える変更をここで検出する (本番の文言表を固定しているのはここだけ)
    expect(await res.clone().json()).toEqual({ error: 'リクエストボディが大きすぎます' });
    // 署名検証まで進んでいない (上限を撤去するとここまで届いてしまう)
    expect(constructEventSpy).not.toHaveBeenCalled();
    // プラン反映も起きていない
    expect(store.tenants.get(TENANT)!.subscriptionPlan).toBe('free');
  });

  // chunked 転送は Content-Length を省略できるため、ストリームの累計バイト数でも検査する。
  // Request は body 文字列から Content-Length を自動付与しないので、この経路がそのまま再現できる
  it('Content-Length が無くても実バイト数が上限超過なら 413 で拒否する', async () => {
    const res = await postStripe(eventBodyOfExactly(STRIPE_WEBHOOK_MAX_BODY_BYTES + 1));
    expect(res.status).toBe(413);
    // 上限で読み取りを打ち切ったので署名検証には進んでいない
    expect(constructEventSpy).not.toHaveBeenCalled();
    expect(store.tenants.get(TENANT)!.subscriptionPlan).toBe('free');
  });

  // 境界値: ちょうど上限のボディは「超過」ではないので通す (> と >= の取り違え防止)
  it('ちょうど上限ぴったりのボディは拒否せず署名検証まで進む', async () => {
    const res = await postStripe(eventBodyOfExactly(STRIPE_WEBHOOK_MAX_BODY_BYTES));
    expect(res.status).toBe(200);
    // 上限ちょうどは通すので署名検証に到達している (>= に取り違えるとここで失敗する)
    expect(constructEventSpy).toHaveBeenCalledTimes(1);
    // 本文が途中で切れていないことも確認する (切り詰めが起きると JSON が壊れて 400 になる)
    expect(store.tenants.get(TENANT)!.subscriptionPlan).toBe('pro');
  });
});
