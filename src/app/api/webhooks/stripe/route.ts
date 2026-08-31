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

  // Stripe クライアントと Webhook Secret を取得する。
  // **署名検証の try とは分ける。** どちらも throw しうるが原因の種類が違い、まとめると
  // 設定不備 (シークレット未設定・API バージョンが想定外) まで「署名検証失敗」の 400 として
  // 報告されてしまい、運用側は鍵の不一致を疑って調べ続けることになる。**分ける理由は
  // 診断可能性**で、再送の抑止ではない (Stripe は 400 でも 500 でも 2xx 以外なら再送し、
  // 失敗が続けばどちらでもエンドポイントを無効化しうる。ステータスの選択でそこは変わらない)。
  // 外向きの文言は一般的なものに留め、原因はサーバログにだけ残す (§9 内部詳細を漏らさない)。
  // **なおステータスは 400 と 500 で分かれるので、粗い区別までは外から付く。** 設定不備は
  // サーバ側の失敗なので 500 が正しく、これを 400 に揃えて隠すと今度は原因の取り違えが戻る。
  // 本文に事情を書かないことで「何がどう壊れているか」は伏せる、という線引きにしている
  let stripe: Stripe;
  let webhookSecret: string;
  try {
    stripe = getStripeClient();
    webhookSecret = getStripeWebhookSecret();
  } catch (err) {
    // 設定不備: 署名の問題ではないので 500 で返す (原因はログにだけ残す)。
    // ラベルは中立にする — この catch はクライアント生成と Webhook Secret 取得の両方を受けるので、
    // 「クライアントの」と書くと Secret 未設定を別の場所の問題として報告してしまう
    console.error('[stripe-webhook] Stripe 設定の取得に失敗:', err);
    return NextResponse.json({ error: 'イベントの受信に失敗しました' }, { status: 500 });
  }

  // 署名を検証して Stripe イベントオブジェクトを取り出す
  let stripeEvent;
  try {
    // constructEvent で署名を検証し、Stripe イベントオブジェクトを取り出す。
    // 署名が不正なら StripeSignatureVerificationError が throw される。
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    // 署名検証失敗: Stripe 由来でない偽装リクエストとして 400 を返す
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

// 「課金が有効なサブスクなのに、適用しようとしているプランが free になった」= Stripe の Price ID を
// プランへ解決できなかった、という異常を引き受けるヘルパー。
//
// なぜこの検知が要るか: stripeStatusToPlan は Price ID が空でも未知でも安全側の free を返すため、
// 戻り値だけでは**正常な解約と区別がつかず、課金中のテナントを無言で降格させてしまう**。
//
// 呼び出し側は nextPlan の確定後・テナント実在確認の後に呼ぶこと。前に置くと Enterprise
// (プラン据え置き) や存在しない tenantId でも発火し、正常な運用が壊れる。
//
// 原因 (環境変数の設定漏れ / Stripe 側の Price 作り直し / ペイロードの形状変化) では分岐しない。
// **課金が有効なサブスクは解約でもダウングレードでもない**ので、そこから free が出てくること自体が
// 「解決できなかった」という意味しか持たない。原因ごとに「片方は再送、片方は降格」と分けると、
// より起きやすい側 (Price の作り直しなど) が黙って降格する穴になる。
//
// 戻り値: このイベントをそのまま適用してよければ true。適用してはいけない場合は
//   - 再送で解決しうる → throw (呼び出し元の catch が 500 を返し、Stripe が再送する)
//   - 再送しても解決しない → false (呼び出し元は何もせず終了し、Stripe には 200 が返る)
async function handleUnresolvablePlanIfNeeded(params: {
  tenantId: string;
  existingTenant: { subscriptionPlan: SubscriptionPlan; stripeEventProcessedAt?: Date | null };
  linkageFields: {
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    stripeSubscriptionStatus: string;
  };
  status: string;
  nextPlan: SubscriptionPlan;
  priceIds: readonly string[];
  selectedPriceId: string;
  itemsTruncated: boolean;
  eventCreatedAt: Date;
}): Promise<boolean> {
  const {
    tenantId,
    existingTenant,
    linkageFields,
    status,
    nextPlan,
    priceIds,
    selectedPriceId,
    itemsTruncated,
    eventCreatedAt,
  } = params;

  // 解決できているならこのヘルパーの出番はない (そのまま適用してよい)
  if (!isActiveSubscriptionStatus(status) || nextPlan !== 'free') return true;

  // 原因の切り分けに要る値をまとめる。顧客名やメールなどの個人情報は載せない (§9)。
  // 設定側の Price ID も載せるのは、「両方の環境変数に同じ値が入っている」ような
  // 対応表そのものの誤りを、ログだけで見分けられるようにするため
  const diagnosticInfo =
    `tenantId=${tenantId}, subscriptionId=${linkageFields.stripeSubscriptionId}, status=${status}, ` +
    `priceIds=[${priceIds.join(', ')}], selectedPriceId=${selectedPriceId || '(空)'}, ` +
    `configured={standard=${STRIPE_PRICE_IDS.standard || '(未設定)'}, pro=${STRIPE_PRICE_IDS.pro || '(未設定)'}}, ` +
    `itemsTruncated=${itemsTruncated}, currentPlan=${existingTenant.subscriptionPlan}`;

  // 配信順序の CAS で確実に無視されるイベントか。判定の根拠は tx 外のスナップショットなので、
  // 並行配信で処理済み時刻が進むと「古いのに古くないと見なす」ことがあるが、再送のたびに
  // 読み直すので自己回復する (逆方向のずれは起きない)。比較の規則は tenant-repository の CAS
  // (stripeEventProcessedAt <= eventCreatedAt なら適用) と対になっており、変えるときは両方見る
  const processedAt = existingTenant.stripeEventProcessedAt ?? null;
  const isStaleEvent = processedAt !== null && eventCreatedAt < processedAt;

  // **プランを解決できなくても、Stripe 連携情報は先に保存する。** この経路はこれらの列の唯一の
  // 書き込み元で、未保存のままにすると stripeCustomerId が null で残り、(a) 顧客ポータルが
  // 開けず自力で解約できない、(b) 再チェックアウトで別 Customer が作られて二重課金になる。
  // プランは渡さないので、解決できなかったプランは書き換わらない。
  // 下の早期 return より前に置くのが要点で、後ろに置くと「再送しない」判断のケースで
  // 保存の機会ごと失われる (古いイベントの場合は CAS が 0 件更新にするため、先に呼んでも無害)。
  const linkageApplied = await repos.tenants.updateStripeSubscription(
    tenantId,
    linkageFields,
    eventCreatedAt,
  );
  // 実際に保存できたかも載せる。保存できていないのに「保存した」と読めるログを出さないため
  const details = `${diagnosticInfo}, linkageSaved=${linkageApplied}`;

  // (1) 古いイベント: CAS が必ず弾くので、何度届いても適用されない。再送させても失敗を積むだけ
  if (isStaleEvent) {
    console.warn(
      '[stripe-webhook] 有効なサブスクリプションの Price ID を解決できませんでしたが、' +
        `より新しいイベントが適用済みのため再送させません (${details})`,
    );
    return false;
  }

  // (2) items が 10 件上限で切り捨てられている: プラン本体の item はページ外のままなので、
  //     同じペイロードが再配信されるだけで再送では解決しない。**プランは判断材料が欠けたまま
  //     なので変更せず**、運用の対応が要る異常として error で残す (warn だと日常の記録に紛れる)。
  //     items を API から取り直す手もあるが、署名検証済みイベントの処理へ外向き通信と新しい
  //     失敗経路を持ち込むことになるため採らない。該当したらアドオン構成の見直しで解消する。
  if (itemsTruncated) {
    console.error(
      '[stripe-webhook] サブスクリプションの items が上限で切り捨てられており、プランを判定できません。' +
        'このテナントのプランは更新されないまま残ります。アドオン構成を確認してください ' +
        `(${details})`,
    );
    return false;
  }

  // (3) それ以外: 原因を直せば再送で解決しうる。分からないままプランを書き換えず throw する
  //     (§9 fail-closed: 不明なら拒否)。200 で受けてしまうと Stripe は再送しないため、
  //     原因を直しても DB は自動復旧しない — 現在のプランが有料なら課金中のテナントが
  //     free + lite で取り残され、free なら成立した契約が反映されないまま取り残される
  //     (新規契約は必ず free からの遷移なのでここに来る)。どちらも手動修復が要る。
  //     「1 件の解決不能な契約でエンドポイントごと無効化されるのでは」という懸念については、
  //     Stripe の自動無効化は**そのエンドポイント全体が継続的に失敗している**ことが条件で、
  //     他のイベントが通っている限り起きない。逆に全イベントが失敗する状況 (対応表が丸ごと
  //     未設定など) は、まさに再送で自動回復してほしいケースにあたる。
  //     **回復には設定修正だけでなく再起動 (再デプロイ) が要る場合がある** — STRIPE_PRICE_IDS は
  //     モジュール評価時に process.env を読む固定値のため。
  //     解約 (customer.subscription.deleted) は Price ID を見ないのでこの経路を通らず、
  //     失効の反映が止まることはない。Enterprise も nextPlan が enterprise なので通らない。
  throw new Error(
    '[stripe-webhook] 有効なサブスクリプションの Price ID をプランへ解決できません。' +
      'プランを書き換えず再送させます。STRIPE_PRICE_STANDARD / STRIPE_PRICE_PRO の設定と ' +
      `Stripe 側の Price ID を確認してください (${details})`,
  );
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

  // Stripe 連携情報 (顧客・サブスク・状態)。プランを解決できた場合とできなかった場合の
  // 両方で同じ 3 列を書くので、1 か所で組み立てて両方へ渡す (§6 DRY)
  const linkageFields = {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    stripeSubscriptionStatus: status,
  };

  // 「課金が有効なサブスクなのに、適用しようとしているプランが free」= プランを解決できなかった、
  // という異常の扱い。判断と記録はヘルパーへ寄せ、ここは呼ぶだけにする (詳細はそちらの冒頭)。
  // 「このイベントを適用してよいか」を返し、適用してはいけない場合は throw するか false を返す
  const shouldApply = await handleUnresolvablePlanIfNeeded({
    tenantId,
    existingTenant,
    linkageFields,
    status,
    nextPlan,
    priceIds,
    selectedPriceId: priceId,
    itemsTruncated,
    eventCreatedAt,
  });
  if (!shouldApply) return;

  // テナントのサブスク情報を更新する (ダウングレードなら Pro モードも同時に強制解除する)
  await applyPlanChange(tenantId, { ...linkageFields, subscriptionPlan: nextPlan }, eventCreatedAt);
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
