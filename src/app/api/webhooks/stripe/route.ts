// Phase 4 課金: Stripe Incoming Webhook ハンドラ。
// docs/smb-dx-pivot-plan.md §6「マネタイズ・販売戦略」— Stripe Billing 連携
//
// Stripe からの課金イベント (サブスク作成・更新・削除・支払い失敗) を受信し、
// Tenant テーブルの subscriptionPlan / stripeSubscriptionStatus を自動更新する。
//
// セキュリティ:
// 1. Stripe-Signature ヘッダの HMAC 署名検証で送信元が本物の Stripe であることを確認する。
//    不正な POST で課金プランが操作されないよう、署名検証失敗は 400 で拒否する。
// 2. Stripe Webhook Secret (STRIPE_WEBHOOK_SECRET) は環境変数のみで管理し、コードにハードコードしない。
// 3. 本ルートは CSRF トークン不要 (Stripe のサーバー→サーバー呼び出し。ブラウザ経由ではない)。
// 4. 本ルートへのリクエストボディは raw bytes で読む必要がある (署名は生の本文に対して計算される)。
//    App Router には bodyParser が無いので、サイズ上限つきの読み取りヘルパー (#287) で生バイト列を
//    取得し、**こちら側では復号せずそのまま** constructEvent へ渡す (#290)。
//
//    **既知の限界 (#290): 生バイト列を渡しても、HMAC の対象は SDK が復号した文字列になる。**
//    stripe@22.4.0 の `parseEventDetails` は payload が Uint8Array なら
//    `new TextDecoder('utf8').decode(payload)` で文字列化し、`verifyHeader` はその文字列で
//    `${timestamp}.${payload}` を組んで HMAC を計算する (`Webhooks.js`)。つまり Buffer を渡しても
//    文字列を渡しても HMAC の入力は同じで、**先頭 BOM の除去・不正 UTF-8 の U+FFFD 置換による
//    署名ずれは SDK の内側で起きるため、このルート層では塞げない**。
//    塞ぐには Stripe の署名方式 (v1 スキーム・タイムスタンプ許容差・リプレイ窓) を自前で
//    実装し直すことになり、§9「暗号・認証情報は自前実装しない」に反するので採らない。
//    それでも復号を SDK 側に寄せてあるのは、(a) このルートが本文の解釈について判断を持たなくなる、
//    (b) SDK が将来バイト列のまま検証するようになれば自動的に追随できる、の 2 点による。
//    実運用では Stripe は妥当な UTF-8 の JSON しか送らないため、現時点で顕在化する不具合ではない。
//    (LINE 側 `inbound/line` は自前で HMAC を計算しているので、そちらは生バイト列で検証している)

import { NextResponse } from 'next/server';
// Stripe SDK の型定義 (Event 型を handleStripeEvent の引数に使う)
import type Stripe from 'stripe';
// データリポジトリ (テナント更新用) + トランザクション境界
import { repos, uow } from '@/data';
// Stripe クライアントと設定ヘルパー
import {
  getStripeClient,
  getStripeWebhookSecret,
  isActiveSubscriptionStatus,
  pickKnownPriceId,
  STRIPE_PRICE_IDS,
  stripeStatusToPlan,
} from '@/lib/stripe';
// レート制限 (署名検証の前に粗すぎる連打を弾いてサーバー負荷を抑える)
import { enforceRateLimit, RateLimitError } from '@/lib/rate-limit';
// Pro モード (7 ステータス・SLA・エスカレーション等) がそのプランで許可されるかの判定
import { isProModeAllowed } from '@/lib/plan-guard';
// 課金プランの型
import type { SubscriptionPlan } from '@/domain/types';
// §4.3 フォローアップ: 設定変更監査ログへの記録を共通化するヘルパー
import { recordSettingsAudit } from '@/lib/settings-audit';
// リクエストボディをサイズ上限つきで読み取るヘルパー (#287)。署名検証は復号前のバイト列に
// 対して行うため、文字列版ではなく生バイト列を返す方を使う (#290)
import { readBodyWithinByteLimit } from '@/lib/request-body-limit';
// 拒否時のログ・ステータス・文言をまとめて組み立てるヘルパー (ルート層の関心事なので別モジュール)
import { bodyRejectResponse } from '@/lib/body-reject-response';
// 拒否理由ごとの文言 (route とテストが同じ表を参照する。理由は同モジュール冒頭)
import { STRIPE_BODY_REJECT_MESSAGES } from '@/lib/webhook-body-reject-messages';
// この経路が受け付けるボディの最大バイト数 (route とテストが同じ定義を参照する)
import { STRIPE_WEBHOOK_MAX_BODY_BYTES } from '@/lib/webhook-body-limits';

// Stripe Webhook が送ってくる主要イベント種別の定数 (typo 防止のため文字列リテラルを定数化)
const STRIPE_EVENT_SUBSCRIPTION_CREATED = 'customer.subscription.created';
const STRIPE_EVENT_SUBSCRIPTION_UPDATED = 'customer.subscription.updated';
const STRIPE_EVENT_SUBSCRIPTION_DELETED = 'customer.subscription.deleted';

// Stripe Webhook のレート制限設定: 1 分あたり 300 件まで (Stripe の通常送信量を超えない上限)
// Stripe の実送信量は低いため、極端に小さくすると Retry 失敗を招く可能性がある
const STRIPE_RATE_LIMIT = { limit: 300, windowMs: 60_000 } as const;

// POST /api/webhooks/stripe — Stripe Webhook エンドポイント
export async function POST(request: Request): Promise<NextResponse> {
  // レート制限: 署名検証の前に短絡して CPU / メモリを守る
  // キーは固定文字列 (Stripe のグローバル IP プールが対象のため、IP ベースの分散は不要)
  try {
    enforceRateLimit('stripe-webhook', STRIPE_RATE_LIMIT);
  } catch (err) {
    // レート制限超過: 429 + Retry-After を返す (Stripe は 429 受信時に再送を遅らせる)
    const retryAfterSec = err instanceof RateLimitError ? err.retryAfterSec : 60;
    return NextResponse.json(
      { error: 'リクエストが多すぎます。しばらく待ってから再試行してください。' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
    );
  }

  // Stripe の署名検証に使うヘッダを取得する (次の行がないと署名検証に失敗する)
  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    // Stripe-Signature ヘッダがない場合はリクエストが Stripe 由来でないと判断して拒否
    return NextResponse.json({ error: 'Stripe-Signature ヘッダが必要です' }, { status: 400 });
  }

  // raw ボディをサイズ上限つきで読む (Stripe の署名検証は生のリクエストボディを必要とする)。
  // 未認証で到達できる経路なので、`stripe-signature` に適当な値を付けた巨大ボディでメモリを
  // 枯渇させられないよう、署名検証より前に上限で打ち切る (§9 / #287)。
  const bodyResult = await readBodyWithinByteLimit(request, STRIPE_WEBHOOK_MAX_BODY_BYTES);
  if (!bodyResult.ok) {
    // どの理由で拒否したかはサーバーログにだけ残し (§6 エラーを握り潰さない)、
    // 外部には理由ごとに決めた文言を返す。ログ・ステータス・文言の組み立ては共通ヘルパーに委ねる
    return bodyRejectResponse(bodyResult, STRIPE_WEBHOOK_MAX_BODY_BYTES, {
      logPrefix: '[stripe-webhook]',
      messages: STRIPE_BODY_REJECT_MESSAGES,
    });
  }
  // 上限内で読み取れた本文のバイト列を、コピーも変換もせずそのまま渡す (#290)。
  // constructEvent の payload 型は `string | Uint8Array` (Stripe SDK の `WebhookPayload`) なので
  // Buffer へ包み直す必要はない。**Buffer.from で包み直さないのは意図的**で、
  // `Buffer.from(bytes.buffer)` のように長さを省いた形へ「単純化」されると、
  // readBodyWithinByteLimit が確保した未使用領域 (16KiB から倍々に伸ばすので最大 maxBytes 近く)
  // まで署名対象に混ざり、全 Webhook が検証失敗する。包まなければその余地自体が無くなる。
  // **なおバイト列を渡しても署名検証が生バイト列基準になるわけではない** — 理由と、
  // それでもこの形にしている根拠はファイル冒頭のセキュリティ要点 4 を参照
  const rawBody = bodyResult.bytes;

  // Stripe クライアントと Webhook Secret を取得する
  let stripeEvent;
  try {
    const stripe = getStripeClient();
    const webhookSecret = getStripeWebhookSecret();
    // constructEvent で署名を検証し、Stripe イベントオブジェクトを取り出す。
    // 署名が不正なら StripeSignatureVerificationError が throw される。
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    // 署名検証失敗: Stripe 由来でない偽装リクエスト (or 設定ミス) として 400 を返す
    console.error('[stripe-webhook] 署名検証失敗:', err);
    return NextResponse.json({ error: 'Webhook 署名の検証に失敗しました' }, { status: 400 });
  }

  // イベント種別に応じてテナントのサブスク情報を更新する
  try {
    await handleStripeEvent(stripeEvent);
  } catch (err) {
    // テナント更新失敗は 500 で返す (Stripe が再送するため冪等性が重要)。
    // フォローアップ (2026-07-20): updateStripeSubscription は eventCreatedAt による CAS
    // (配信順序チェック) を行うようになったが、同一イベントの再送 (event.created が同じ) は
    // 「保存済みの直近処理イベント時刻 <= 今回の event.created」の条件に一致するため
    // 通常どおり (べき等に) 再適用される。再送時に安全なのは古いイベントを弾く仕組みと
    // 両立している
    console.error('[stripe-webhook] イベント処理エラー:', err);
    return NextResponse.json({ error: 'イベント処理に失敗しました' }, { status: 500 });
  }

  // 正常完了: 200 を返す (Stripe は 2xx を受け取ると再送しない)
  return NextResponse.json({ received: true });
}

// Stripe イベントの種別に応じてテナントを更新する内部ハンドラ
// Stripe.Event は stripe SDK が公開する公式のイベント型
async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  // イベント種別を取り出す (Stripe.Event の type フィールドは string)
  const { type } = event;
  // data.object を Record<string, unknown> として扱うことでフィールドアクセスを柔軟にする
  // unknown を経由することで型安全にキャストする (Stripe の各イベントオブジェクト型は
  // index signature を持たないため直接 Record にはキャストできない)
  const obj = event.data.object as unknown as Record<string, unknown>;
  // フォローアップ (監査で発見したギャップ 2026-07-20): Stripe イベント自体の発生時刻
  // (Unix 秒)。配信順序が保証されないため、適用可否の CAS 判定に使う (event.created は
  // Stripe.Event が必ず持つフィールドだが、§9 fail-closed に従い型を信用せず値を検証する)。
  // 不正な値のまま Date 化すると Invalid Date (NaN) になり、CAS の比較が常に false 判定
  // (どんな比較も NaN を含むと false) になって配信順序チェックがそのテナントだけ無効化されて
  // しまう。ここで検出して処理を中断し、呼び出し元 (POST ハンドラ) の catch で 500 を返して
  // Stripe に再送させる方が安全 (§9: 不明なら拒否)
  if (!Number.isFinite(event.created)) {
    throw new Error(`Stripe イベントの created が不正です: ${String(event.created)}`);
  }
  const eventCreatedAt = new Date(event.created * 1000);

  // サブスクリプション作成・更新イベント: プランと状態を更新する
  if (type === STRIPE_EVENT_SUBSCRIPTION_CREATED || type === STRIPE_EVENT_SUBSCRIPTION_UPDATED) {
    await handleSubscriptionUpsert(obj, eventCreatedAt);
    return;
  }

  // サブスクリプション削除イベント: free プランに降格し、Stripe 連携情報を保持する
  if (type === STRIPE_EVENT_SUBSCRIPTION_DELETED) {
    await handleSubscriptionDeleted(obj, eventCreatedAt);
    return;
  }

  // 未対応のイベントは無視する (200 を返すことで Stripe が再送しないようにする)
}

// Stripe 由来のプラン変更をテナントへ適用する共通ヘルパー。
//
// なぜ必要か: 新プランが Pro モードを許可しなくなった (ダウングレード/解約) 場合、
// tenant.mode がそれまでの 'pro' のまま残ると、エスカレーションや 7 ステータスワークフローなど
// Pro 専用機能がプラン変更後も使い続けられてしまう (§9 認可はサーバー側で強制)。
// updateStripeSubscription (プラン反映) と updateMode (Pro モード強制解除) を
// 1 つのトランザクションにまとめ、片方だけ反映される中間状態が残らないようにする。
//
// mode の読み取りは呼び出し元からではなく、トランザクション内で tx.tenants.findById により
// 都度読み直す (呼び出し元の existingTenant はトランザクション開始前に取得したスナップショットで、
// その後に届いた別の Stripe イベントや管理者操作で mode が変わっていても反映されない古い値になり得るため)。
//
// フォローアップ (監査で発見したギャップ 2026-07-20): Stripe は Webhook イベントの配信順序を
// 保証しない (公式ドキュメント記載。リトライ・ネットワーク遅延で発生順とは異なる順序で届きうる)。
// eventCreatedAt (今回のイベント自体の発生時刻) を updateStripeSubscription の CAS 判定に渡し、
// 既により新しいイベントが適用済みなら今回の更新は無視する (古いイベントで新しい状態を巻き戻さない)。
async function applyPlanChange(
  tenantId: string,
  stripeFields: {
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    stripeSubscriptionStatus: string;
    subscriptionPlan: SubscriptionPlan;
  },
  eventCreatedAt: Date,
): Promise<void> {
  const { applied, shouldResetMode, planChanged } = await uow.run(async (tx) => {
    // トランザクション内で最新のテナント状態を読み直す (呼び出し元のスナップショットに頼らない)
    const tenant = await tx.tenants.findById(tenantId);
    // 呼び出し元で存在確認済みだが、念のためここでも安全側 (何もしない) に倒す
    if (!tenant) return { applied: false, shouldResetMode: false, planChanged: false };
    // /code-review ultra 指摘対応 (2026-07-13): 監査ログに残すため、更新前のプランを保持しておく
    const previousPlan = tenant.subscriptionPlan;
    // Stripe 連携情報とプランを反映する (CAS: 保存済みの直近処理イベントより古ければ 0 件更新で false)
    const applied = await tx.tenants.updateStripeSubscription(
      tenantId,
      stripeFields,
      eventCreatedAt,
    );
    // 古いイベントとして無視された場合、mode リセット・監査ログ記録も行わない
    // (このイベントの subscriptionPlan は既に上書きされた古い情報のため判断材料にしない)
    if (!applied) return { applied: false, shouldResetMode: false, planChanged: false };
    // 現在 Pro モードで運用中かつ、新プランが Pro モードを許可しないときだけモードを戻す
    const shouldReset = tenant.mode === 'pro' && !isProModeAllowed(stripeFields.subscriptionPlan);
    if (shouldReset) {
      // Pro 専用機能を使えなくする (Lite モードへ強制的に戻す)
      await tx.tenants.updateMode(tenantId, 'lite');
    }
    return {
      applied: true,
      shouldResetMode: shouldReset,
      planChanged: previousPlan !== stripeFields.subscriptionPlan,
    };
  });

  // 古いイベントとして無視された場合はログに残して終了する (Stripe には 200 を返し再送させない。
  // 呼び出し元の POST ハンドラは常に 200 系で応答するため、ここで throw せず正常終了する)
  if (!applied) {
    console.warn(
      `[stripe-webhook] テナント ${tenantId}: より新しい Stripe イベントが適用済みのため、` +
        `このイベント (event.created=${eventCreatedAt.toISOString()}) は無視しました`,
    );
    return;
  }

  // §4.3 フォローアップ (2026-07-10): モードが強制的に戻された場合は監査ログにも記録する。
  // §4.3 で tenant_mode_update アクションを追加した際は管理者による手動切替 (update-tenant-mode.ts)
  // しか対象にしておらず、Stripe イベント起因の自動ダウングレードは監査対象から漏れていた
  // (「誰がいつ Pro モードに切り替えたか」を追えるはずの §4.3 の意図に反する)。
  // ここは操作したユーザーが存在しないシステム操作のため actorId は null (システムアクター) を渡す。
  // 監査ログの書き込み失敗は本来の処理 (プラン反映) の成否に影響させない (recordSettingsAudit の方針)。
  //
  // フォローアップ (2026-07-13): 監査で発見したギャップの解消。§4.2-§4.6 が SSO/LINE/通知チャネル/
  // テナントモード/拠点/招待リンクまで監査対象を広げてきた一方、それらより上位の「組織設定」である
  // subscriptionPlan 自体の変更 (アップグレード/ダウングレード/解約) は tenant_mode_update の
  // 副作用としてしか記録されず (Pro モードで運用中のダウングレードのみ)、プラン変更そのものは
  // 一度も監査対象になっていなかった。Enterprise プランが謳う「監査強化」の実態と乖離するため、
  // プランが実際に変わった場合は常に (mode リセットの有無に関わらず) 記録する。
  // 2 つの監査ログ書き込みは互いに独立した I/O なので Promise.all で並行実行する (§8 パフォーマンス)
  await Promise.all([
    shouldResetMode
      ? recordSettingsAudit({
          tenantId,
          actorId: null,
          action: 'tenant_mode_update',
          logPrefix: '[stripe-webhook]',
        })
      : Promise.resolve(),
    planChanged
      ? recordSettingsAudit({
          tenantId,
          actorId: null,
          action: 'subscription_plan_update',
          logPrefix: '[stripe-webhook]',
        })
      : Promise.resolve(),
  ]);
}

// サブスクリプション作成・更新を処理する: テナントのプランと状態を最新に保つ
async function handleSubscriptionUpsert(
  subscriptionObject: Record<string, unknown>,
  eventCreatedAt: Date, // このイベント自体の発生時刻 (配信順序が保証されないための CAS 判定に使う)
): Promise<void> {
  // Stripe のサブスクリプションオブジェクトから必要なフィールドを取り出す
  const subscriptionId = subscriptionObject['id'] as string | undefined;
  const customerId = subscriptionObject['customer'] as string | undefined;
  const status = subscriptionObject['status'] as string | undefined;
  // items に含まれる Price ID をすべて取り出し、その中からプラン判定に使う 1 件を選ぶ。
  // サブスクリプションは座席追加や従量課金のアドオンで複数 item を持つことがあり、
  // items の並び順は保証されないため、先頭を無条件に使うとアドオンの ID を拾って
  // 本来 Pro のテナントを「未知の Price ID」として扱ってしまう (選び方は pickKnownPriceId)
  const items = subscriptionObject['items'] as
    { data?: Array<{ price?: { id?: string } }>; has_more?: boolean } | undefined;
  const priceIds = (items?.data ?? []).map((item) => item?.price?.id ?? '');
  // Stripe はサブスクに埋め込む item を既定 10 件までしか載せず、超過分は has_more で示す。
  // 11 件以上のアドオンを持つ契約ではプラン本体の item がページ外に落ちうるので、
  // 解決できなかったときの診断に含める (API を再取得しない理由は下の throw を参照)
  const itemsTruncated = items?.has_more === true;
  const priceId = pickKnownPriceId(priceIds, STRIPE_PRICE_IDS);
  // メタデータから tenantId を取得する (チェックアウト時に metadata.tenantId として設定する)
  const metadata = subscriptionObject['metadata'] as Record<string, string> | undefined;
  const tenantId = metadata?.['tenantId'];

  // 必須フィールドが揃っていない場合はスキップ (不完全なデータで更新しない)
  if (!subscriptionId || !customerId || !status || !tenantId) {
    console.warn('[stripe-webhook] サブスクリプションに必須フィールドが不足しています:', {
      subscriptionId,
      customerId,
      status,
      tenantId,
    });
    return;
  }

  // Stripe の状態と Price ID からプランを判定する
  const plan = stripeStatusToPlan(status, priceId, STRIPE_PRICE_IDS);

  // tenantId はチェックアウト時にメタデータに埋め込んだ値だが、
  // ユーザーが Stripe のチェックアウトセッション生成時に任意の値を渡せる可能性があるため
  // DB にテナントが実在することを確認してからサブスク情報を更新する。
  // これにより、悪意あるメタデータ改ざんによるクロステナント課金昇格を防ぐ。
  const existingTenant = await repos.tenants.findById(tenantId);
  if (!existingTenant) {
    // 存在しない tenantId の場合はスキップして処理を止める (Stripe は 200 を受け取り再送しない)
    console.warn(
      '[stripe-webhook] メタデータの tenantId に対応するテナントが見つかりません:',
      tenantId,
    );
    return;
  }

  // Enterprise は個別見積で Stripe の自助課金外 (運用が手動設定)。万一 Enterprise テナントに
  // 無関係な Stripe サブスク (旧 Pro 等) が残っていても、Stripe イベントでプランを降格させない。
  // Stripe 連携情報 (customer/subscription/status) は最新化しつつ、プランは enterprise を維持する。
  const nextPlan = existingTenant.subscriptionPlan === 'enterprise' ? 'enterprise' : plan;

  // ここから下は「課金が有効なサブスクなのに、適用しようとしているプランが free」という異常の扱い。
  // stripeStatusToPlan は Price ID が空でも未知でも安全側の free を返すだけなので、戻り値だけでは
  // **正常な解約と区別がつかず、課金中のテナントを無言で降格させてしまう**。
  //
  // この検査を nextPlan の確定後・テナント実在確認の後に置いているのは、実際にプランが
  // 書き換わるケースだけを対象にするため。前に置くと、Enterprise (プラン据え置き) や存在しない
  // tenantId でも発火し、正常な運用が恒常的に 500 になってしまう。
  //
  // 検知は「解決できたかどうか」の一点だけで行い、原因 (環境変数の設定漏れ / Stripe 側の Price
  // 作り直し / ペイロードの形状変化) では分岐しない。**課金が有効なサブスクは、解約でも
  // ダウングレードでもない**ので、そこから free が出てくること自体が「プランを解決できなかった」
  // という意味しか持たない。原因ごとに「片方は再送、片方は降格」と分けると、より起きやすい
  // 側 (Price の作り直しなど) が黙って降格する穴になる。現在のプランでも分岐しない
  // (理由は下記のとおり。free からの新規契約が失われる側も同じ重さの事故になる)。
  if (isActiveSubscriptionStatus(status) && nextPlan === 'free') {
    // 原因の切り分けに要る値をまとめる。顧客名やメールなどの個人情報は載せない (§9)。
    // priceIds を配列のまま出すのは、複数 item のうち何が届いていたかを見えるようにするため。
    const diagnosticInfo =
      `tenantId=${tenantId}, subscriptionId=${subscriptionId}, status=${status}, ` +
      `priceIds=[${priceIds.join(', ')}], selectedPriceId=${priceId || '(空)'}, ` +
      `itemsTruncated=${itemsTruncated}, currentPlan=${existingTenant.subscriptionPlan}`;

    // 配信順序の CAS で確実に無視されるイベント (このテナントは既により新しいイベントまで
    // 適用済み) は、再送しても永久に適用されない。適用されないものを再送させ続けると、
    // 「他のイベントは通っているのに 1 件だけ落ち続ける」ノイズを作るだけなので、
    // 記録だけ残して通す (applyPlanChange 側の CAS が実際の適用を止める)
    // 判定の根拠は tx 外のスナップショットなので、並行配信で処理済み時刻が進むと
    // 「古いのに古くないと見なす」ことがある。その場合も再送のたびに読み直すので自己回復する
    // (逆方向のずれ = 古くないのに古いと見なす、は起きない)。
    // 比較の規則は tenant-repository の CAS (stripeEventProcessedAt <= eventCreatedAt なら適用)
    // と対になっている。片方だけ変えるとここが噛み合わなくなるので、変えるときは両方見る
    const processedAt = existingTenant.stripeEventProcessedAt ?? null;
    const isStaleEvent = processedAt !== null && eventCreatedAt < processedAt;

    // **プランを解決できなくても、Stripe 連携情報 (customer/subscription/status) は先に保存する。**
    // この経路はこれらの列の唯一の書き込み元で、未保存のままにすると stripeCustomerId が
    // null で残り、(a) 顧客ポータルが開けず自力で解約できない、(b) 再チェックアウトで別の
    // Customer が作られて二重課金になる。プランは渡さない (subscriptionPlan は省略可能) ので、
    // 解決できなかったプランは書き換わらない。
    //
    // **下の早期 return より前に置くのが要点**: 早期 return は「再送しない」= この 1 通で
    // 保存を終わらせるという判断なので、後ろに置くと保存の機会ごと失われる
    // (古いイベントの場合は下の CAS が 0 件更新にするため、先に呼んでも無害)。
    const linkageApplied = await repos.tenants.updateStripeSubscription(
      tenantId,
      {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        stripeSubscriptionStatus: status,
      },
      eventCreatedAt,
    );
    // 実際に保存できたかをログに載せる (CAS に弾かれて 0 件更新なら false)。
    // 保存できていないのに「保存した」と読めるログを出さないため (§6 エラーを握り潰さない)
    const linkageInfo = `linkageSaved=${linkageApplied}`;

    // 再送しても解決できないと分かっているケースは、再送させても失敗を積むだけなので通す。
    //   - 古いイベント: CAS が必ず弾くので、何度届いても適用されない
    //   - items が 10 件超で切り捨てられている: プラン本体の item はページ外のままで、
    //     同じペイロードが再配信されるだけ (API から取り直さない理由は下記)
    if (isStaleEvent || itemsTruncated) {
      console.warn(
        '[stripe-webhook] 有効なサブスクリプションの Price ID を解決できませんでしたが、' +
          '再送しても解決できないため再送させません' +
          `(${isStaleEvent ? 'より新しいイベントが適用済み' : 'items が上限で切り捨て'}: ` +
          `${diagnosticInfo}, ${linkageInfo})`,
      );
      return;
    }

    // 分からないままプランを書き換えるのではなく throw し、呼び出し元に 500 を返させて
    // Stripe に再送させる (§9 fail-closed: 不明なら拒否)。
    //
    // 200 で受けてしまうと Stripe は再送しないため、原因を直しても DB は自動復旧しない:
    //   - 現在のプランが有料なら、課金中のテナントが free + lite のまま取り残される
    //   - 現在のプランが free なら、成立したはずの契約が反映されず、顧客は課金だけされて
    //     機能が付かないまま取り残される (新規契約は必ず free からの遷移なのでここに来る)
    // どちらも手動修復が要るので、現在のプランでは分岐せず一律で再送に委ねる。
    //
    // 「解決できない 1 件がエンドポイントごと無効化するのでは」という懸念については、
    // Stripe の自動無効化は**そのエンドポイント全体が継続的に失敗している**ことが条件で、
    // 他のイベントが通っている限り 1 サブスク分の失敗では起きない。逆に全イベントが
    // 失敗する状況 (対応表が丸ごと未設定など) は、まさに再送で自動回復してほしいケース。
    //
    // **回復には設定修正だけでなくプロセスの再起動 (再デプロイ) が要る場合がある** —
    // STRIPE_PRICE_IDS はモジュール評価時に process.env を読む固定値のため。
    // 解約 (customer.subscription.deleted) は Price ID を見ないのでこの経路を通らず、
    // 失効の反映が止まることはない。Enterprise も nextPlan が enterprise なので通らない。
    //
    // **既知の限界**: items が 10 件を超えるとプラン本体の item がページ外に落ち、再送しても
    // 解決できない (diagnosticInfo の itemsTruncated=true がその印)。ここで items を API から
    // 取り直すこともできるが、署名検証済みのイベント処理に外向き通信と新しい失敗経路を
    // 持ち込むことになるため採らない。該当したら運用でアドオン構成を見直す。
    throw new Error(
      '[stripe-webhook] 有効なサブスクリプションの Price ID がどのプランにも一致せず、' +
        'プランを判定できません。プランを書き換えず再送させます。' +
        'STRIPE_PRICE_STANDARD / STRIPE_PRICE_PRO の設定と Stripe 側の Price ID を確認してください ' +
        `(${diagnosticInfo}, ${linkageInfo})`,
    );
  }

  // テナントのサブスク情報を更新する (ダウングレードなら Pro モードも同時に強制解除する)
  await applyPlanChange(
    tenantId,
    {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      stripeSubscriptionStatus: status,
      subscriptionPlan: nextPlan,
    },
    eventCreatedAt,
  );
}

// サブスクリプション削除を処理する: free プランに降格してキャンセル状態を記録する
async function handleSubscriptionDeleted(
  subscriptionObject: Record<string, unknown>,
  eventCreatedAt: Date, // このイベント自体の発生時刻 (配信順序が保証されないための CAS 判定に使う)
): Promise<void> {
  // サブスクリプション ID と status を取得する
  const subscriptionId = subscriptionObject['id'] as string | undefined;
  const customerId = subscriptionObject['customer'] as string | undefined;
  // メタデータから tenantId を取得する
  const metadata = subscriptionObject['metadata'] as Record<string, string> | undefined;
  const tenantId = metadata?.['tenantId'];

  // 必須フィールドが揃っていない場合はスキップ (customerId も含めて確認)
  if (!subscriptionId || !customerId || !tenantId) {
    console.warn('[stripe-webhook] 削除イベントに必須フィールドが不足しています:', {
      subscriptionId,
      customerId,
      tenantId,
    });
    return;
  }

  // upsert と同様にテナント実在チェックを行い、不正な tenantId による操作を防ぐ
  const existingTenant = await repos.tenants.findById(tenantId);
  if (!existingTenant) {
    console.warn(
      '[stripe-webhook] 削除イベントの tenantId に対応するテナントが見つかりません:',
      tenantId,
    );
    return;
  }

  // Enterprise は Stripe 管理外のため、削除イベントでも free に降格させない (手動設定を尊重)。
  const nextPlan = existingTenant.subscriptionPlan === 'enterprise' ? 'enterprise' : 'free';

  // サブスクリプション削除後は (Enterprise を除き) free に降格し、canceled 状態を記録する
  // (free は Pro モード対象外なので Pro モードも同時に強制解除される)
  await applyPlanChange(
    tenantId,
    {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      stripeSubscriptionStatus: 'canceled', // Stripe の deleted イベントは canceled 扱いにする
      subscriptionPlan: nextPlan, // Enterprise 以外は free に降格
    },
    eventCreatedAt,
  );
}
