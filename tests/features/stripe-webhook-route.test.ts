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
// constructEventSpy は「署名検証へ渡る生ボディ」を検証するために呼び出しを記録する。
// #290 以降、ルートは復号を挟まず受信バイト列そのものを Buffer で渡すため、
// スパイ側も Buffer を受け取れる形にしてある (本物の Stripe SDK も string | Buffer を受け付ける)
const { planForNextCall, priceIdsForNextCall, constructEventSpy } = vi.hoisted(() => ({
  planForNextCall: { current: 'pro' as 'free' | 'standard' | 'pro' },
  // Price ID の対応表。既定は「両方設定済み」で、環境変数の設定不全を再現するテストだけ空にする
  priceIdsForNextCall: { current: { standard: 'price_standard', pro: 'price_pro' } },
  // 署名検証はモックで飛ばし、受け取ったバイト列を JSON として解釈するだけにする。
  // 引数の型を Uint8Array に固定してあるのが要点で、ルートが復号済みの文字列を渡す形へ
  // 退行すると型チェックと実行時の両方で落ちる (SDK の WebhookPayload は string も許すため、
  // 本物の型をそのまま使うと退行を検出できない)。
  // 復号に TextDecoder を使うのは、BOM 付きの本文でも JSON として解釈できるようにするため。
  // **このスパイの復号はあくまで JSON 解釈用**で、署名対象が何だったかは
  // mock.calls に記録された引数そのもので確かめる
  constructEventSpy: vi.fn(
    (rawBody: Uint8Array) => JSON.parse(new TextDecoder().decode(rawBody)) as unknown,
  ),
}));
vi.mock('@/lib/stripe', async (importOriginal) => {
  // 「有効な status とは何か」の規則だけは本物を使う。ここでモックすると、
  // 未知 Price ID の検知テストが本番と違う規則を相手に緑になってしまう (§6 DRY)
  const actual = await importOriginal<typeof import('@/lib/stripe')>();
  return {
    // 署名検証はモックし、リクエストボディの JSON をそのまま Stripe イベントとして扱う
    getStripeClient: () => ({
      webhooks: {
        constructEvent: constructEventSpy,
      },
    }),
    getStripeWebhookSecret: () => 'whsec_test',
    // 本来は status + priceId から判定するが、テストでは明示的に差し替えて挙動を固定する
    stripeStatusToPlan: () => planForNextCall.current,
    // status が active / trialing かの判定は本物をそのまま使う
    isActiveSubscriptionStatus: actual.isActiveSubscriptionStatus,
    // 複数 item から判定用の Price ID を選ぶ規則も本物を使う (対応表は引数で渡る純粋関数)
    pickKnownPriceId: actual.pickKnownPriceId,
    // Price ID の対応表 (getter にして beforeEach / 各テストの差し替えを反映させる)
    get STRIPE_PRICE_IDS() {
      return priceIdsForNextCall.current;
    },
  };
});

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
    // Price ID の対応表は既定で「両方設定済み」に戻す (設定不全は該当テストだけで再現する)
    priceIdsForNextCall.current = { standard: 'price_standard', pro: 'price_pro' };
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

  // 課金が有効なサブスクなのにプランを解決できないイベントは、そもそも適用しない。
  // 有効なサブスクは解約でもダウングレードでもないので、そこから free が出てくること自体が
  // 「判定に失敗した」という意味しか持たない。200 + 降格にすると Stripe は再送しないため、
  // 原因 (環境変数の設定漏れ / Stripe 側の Price 作り直し / ペイロードの形状変化) を直しても
  // DB は自動復旧せず、課金中のテナントが free + lite のまま取り残される
  it.each([
    ['対応表は揃っているが Price ID が未知', { standard: 'price_standard', pro: 'price_pro' }],
    ['両方とも未設定', { standard: '', pro: '' }],
    ['Standard だけ未設定', { standard: '', pro: 'price_pro' }],
    ['Pro だけ未設定', { standard: 'price_standard', pro: '' }],
  ])('プランを解決できないイベント (%s) は適用せず 500 で再送させる', async (_名, 表) => {
    seedTenant('pro', 'pro');
    // Price ID がどのプランにも一致しなかった状況を再現する (判定結果は free)
    planForNextCall.current = 'free';
    priceIdsForNextCall.current = 表;
    // ログ出力はテスト出力に混ぜたくないので実装を握りつぶしつつ呼び出しだけ記録する
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      makeRequest({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            // status は有効なまま (= 解約ではない)。ここが「無言の降格」の分かれ目
            status: 'active',
            items: { data: [{ price: { id: 'price_unknown' } }] },
            metadata: { tenantId: TENANT },
          },
        },
      }),
    );
    // 500 を返すことで Stripe が再送し、原因を直したあとの再配信で正しい状態が入る
    expect(res.status).toBe(500);
    // プランもモードも書き換わっていないこと (これが守りたい本体)
    const tenant = store.tenants.get(TENANT)!;
    expect(tenant.subscriptionPlan).toBe('pro');
    expect(tenant.mode).toBe('pro');
    // 原因の切り分けに要る値がログに残ること (顧客名・メール等の個人情報は載せない)
    const logged = errorSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('どのプランにも一致せず');
    expect(logged).toContain('priceId=price_unknown');
    expect(logged).toContain('currentPlan=pro');
    errorSpy.mockRestore();
  });

  // 正規の解約 (status が有効でない) は異常ではないので、500 にしてはいけない。
  // ここが無いと「free になったら常に 500」という実装に退行しても気付けず、
  // 解約の反映が永久に止まる
  it('正規の解約による free 降格は 500 にせず、そのまま適用する', async () => {
    seedTenant('pro', 'pro');
    planForNextCall.current = 'free';
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      makeRequest({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            // 失効した状態 (= 有効な status ではない)
            status: 'canceled',
            items: { data: [{ price: { id: 'price_pro' } }] },
            metadata: { tenantId: TENANT },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(store.tenants.get(TENANT)!.subscriptionPlan).toBe('free');
  });

  // Enterprise はプランが据え置かれる (= 書き換わらない) ので、未知 Price ID でも 500 にしない。
  // Enterprise は個別見積の独自 Price を持つのが通常なので、ここで止めると
  // 請求サイクルごとに Webhook が失敗し続けてエンドポイントごと無効化されかねない
  it('Enterprise テナントは未知 Price ID でもプランが据え置かれ 500 にならない', async () => {
    seedTenant('pro', 'enterprise');
    planForNextCall.current = 'free';
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      makeRequest({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'active',
            items: { data: [{ price: { id: 'price_ent_custom' } }] },
            metadata: { tenantId: TENANT },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(store.tenants.get(TENANT)!.subscriptionPlan).toBe('enterprise');
  });

  // サブスクは座席追加や従量課金のアドオンで複数 item を持つことがあり、items の並び順は
  // 保証されない。先頭を無条件に使うと、アドオンの Price ID を拾って本来 Pro のテナントが
  // 「解決できないイベント」として 500 になり、正常な契約が止まってしまう
  it('複数 item のサブスクでは、既知プランの Price ID を選んで判定する', async () => {
    seedTenant('lite', 'free');
    // 本物の判定関数と同じ経路を通すため、ここではプラン判定をモックしない代わりに
    // 「pro と判定されたら適用される」ことを確認する
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
            // アドオンが先頭、本命の Pro が 2 番目という並び
            items: {
              data: [{ price: { id: 'price_addon_seats' } }, { price: { id: 'price_pro' } }],
            },
            metadata: { tenantId: TENANT },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(store.tenants.get(TENANT)!.subscriptionPlan).toBe('pro');
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

  // #287 / #290: SDK の署名検証へ渡るのが「受信したバイト列そのもの」であることを固定する。
  // 読み取り方法の変更は署名検証の回帰に直結する (デコードや切り詰めが 1 箇所でも挟まると
  // 正規の Stripe イベントが全て検証失敗になり、課金状態の反映が丸ごと止まる) ため、
  // マルチバイト文字を含む本文で「受信した本文そのもの」が渡ることを表明する
  it('SDK には受信した本文がそのまま渡る (マルチバイト文字を含んでも一致する)', async () => {
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
    // 署名検証へ渡った第 1 引数が、送信したバイト列と完全一致する
    // (これが崩れると HMAC が不一致になる)
    expect(constructEventSpy).toHaveBeenCalledTimes(1);
    const passed = constructEventSpy.mock.calls[0]![0];
    // #290: 復号済み文字列ではなく生バイト列が渡ることを表明する
    // (SDK の payload 型は string も許すので、渡し方の退行はここでしか捕まえられない)
    expect(passed).toBeInstanceOf(Uint8Array);
    // 送信した本文を UTF-8 でエンコードしたバイト列と 1 バイトも違わない
    expect(Buffer.compare(passed, Buffer.from(body, 'utf8'))).toBe(0);
    // 署名検証の先まで進み、プラン反映まで到達している
    expect(store.tenants.get(TENANT)!.subscriptionPlan).toBe('pro');
  });

  // #290: 先頭 BOM (EF BB BF) を含む本文でも、ルートが本文を加工せず SDK へ渡すこと。
  //
  // **このテストが表明する範囲に注意。** constructEvent はモックなので、確かめているのは
  // 「ルート層が受信バイト列を BOM ごとそのまま境界へ渡す」ところまでで、**署名検証が
  // 生バイト列基準で成立すること**ではない。実際の SDK (stripe@22.4.0) は payload を内部で
  // TextDecoder に通してから HMAC を組むため、BOM によるずれは SDK の内側に残る
  // (根拠と、それでもバイト列を渡す理由は route ファイル冒頭のセキュリティ要点 4)。
  // それでもこの表明に価値があるのは、**ルート層が復号・切り詰め・正規化を再び挟む退行**を
  // 検出できるため (SDK が将来バイト列で検証するようになった時に効いてくる前提条件でもある)
  it('先頭 BOM を含む本文でも、ルートは BOM 込みのバイト列を SDK へ渡す', async () => {
    seedTenant('lite', 'free');
    const json = JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_bom',
          customer: 'cus_bom',
          status: 'active',
          items: { data: [{ price: { id: 'price_pro' } }] },
          metadata: { tenantId: TENANT },
        },
      },
    });
    // BOM を先頭に付けたバイト列を作る (文字列ではなくバイト列で送るのが要点)
    const bodyBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, 'utf8')]);
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      new Request('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
        body: bodyBytes,
      }),
    );
    expect(res.status).toBe(200);
    // SDK へ渡ったバイト列に BOM がそのまま残っている (ルートで復号を挟むと 3 バイト短くなる)
    expect(constructEventSpy).toHaveBeenCalledTimes(1);
    expect(Buffer.compare(constructEventSpy.mock.calls[0]![0], bodyBytes)).toBe(0);
  });

  // #290: 不正な UTF-8 バイト列を含む本文でも、ルート層で置換文字 (U+FFFD) へ潰さないこと。
  // 表明の範囲は上の BOM のテストと同じ (ルート層が加工しないところまで)。
  // 不正バイトは Stripe が JSON 文字列として扱える位置 (metadata の値) に混ぜる
  it('不正な UTF-8 を含む本文でも、ルートは置換せずそのまま SDK へ渡す', async () => {
    seedTenant('lite', 'free');
    // 単独の 0x80 は UTF-8 として不正 (継続バイトが先頭に来ている)。復号すると U+FFFD になる
    const invalidUtf8 = Buffer.from([0x80]);
    // JSON 構造は壊さず metadata.memo の値の中にだけ不正バイトを差し込む。
    // 目印を JSON へ埋めてから前後で切り、その隙間に不正バイトを挟む
    // (文字列置換で組み立てると閉じ括弧の位置がずれて JSON が壊れる)
    const [beforeMarker, afterMarker] = JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_bad',
          customer: 'cus_bad',
          status: 'active',
          items: { data: [{ price: { id: 'price_pro' } }] },
          metadata: { tenantId: TENANT, memo: 'INVALID_BYTE_HERE' },
        },
      },
    }).split('INVALID_BYTE_HERE');
    const bodyBytes = Buffer.concat([
      Buffer.from(beforeMarker!, 'utf8'),
      invalidUtf8,
      Buffer.from(afterMarker!, 'utf8'),
    ]);
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(
      new Request('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
        body: bodyBytes,
      }),
    );
    expect(res.status).toBe(200);
    // SDK へ渡ったバイト列が受信したものと 1 バイトも違わない
    // (ルートで復号を挟むと 0x80 が U+FFFD の 3 バイトへ膨らんで落ちる)
    expect(constructEventSpy).toHaveBeenCalledTimes(1);
    expect(Buffer.compare(constructEventSpy.mock.calls[0]![0], bodyBytes)).toBe(0);
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
    // 文言がこの経路の文言表の 'too-large' と一致する (表の項目を入れ替える変更を検出する)。
    // 「ステータスで文言を選ぶ実装」への退行は too-large では検出できない (どちらも同じ文字列)。
    // それは tests/webhook-body-reject-messages.test.ts の
    // 「各理由の文言がそのまま応答本文になる」が受け持つ
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
