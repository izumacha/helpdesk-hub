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
// 4. 本ルートへのリクエストボディは raw bytes で読む必要がある。
//    Next.js の bodyParser が動く前に raw body を取得するため、
//    App Router では Request.text() または arrayBuffer() を使う。

import { NextResponse } from 'next/server';
// Stripe SDK の型定義 (Event 型を handleStripeEvent の引数に使う)
import type Stripe from 'stripe';
// データリポジトリ (テナント更新用) + トランザクション境界
import { repos, uow } from '@/data';
// Stripe クライアントと設定ヘルパー
import { getStripeClient, getStripeWebhookSecret, stripeStatusToPlan } from '@/lib/stripe';
// レート制限 (署名検証の前に粗すぎる連打を弾いてサーバー負荷を抑える)
import { enforceRateLimit, RateLimitError } from '@/lib/rate-limit';
// Pro モード (7 ステータス・SLA・エスカレーション等) がそのプランで許可されるかの判定
import { isProModeAllowed } from '@/lib/plan-guard';
// 課金プランの型
import type { SubscriptionPlan } from '@/domain/types';
// §4.3 フォローアップ: 設定変更監査ログへの記録を共通化するヘルパー
import { recordSettingsAudit } from '@/lib/settings-audit';

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

  // raw ボディを文字列で読む (Stripe の署名検証は生のリクエストボディを必要とする)
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    // ボディ読み取り失敗は 400 で返す (ボディが壊れている場合)
    return NextResponse.json(
      { error: 'リクエストボディの読み取りに失敗しました' },
      { status: 400 },
    );
  }

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
    // テナント更新失敗は 500 で返す (Stripe が再送するため冪等性が重要)
    // 再送時に重複処理しても安全なように updateStripeSubscription は上書き更新
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

  // サブスクリプション作成・更新イベント: プランと状態を更新する
  if (type === STRIPE_EVENT_SUBSCRIPTION_CREATED || type === STRIPE_EVENT_SUBSCRIPTION_UPDATED) {
    await handleSubscriptionUpsert(obj);
    return;
  }

  // サブスクリプション削除イベント: free プランに降格し、Stripe 連携情報を保持する
  if (type === STRIPE_EVENT_SUBSCRIPTION_DELETED) {
    await handleSubscriptionDeleted(obj);
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
async function applyPlanChange(
  tenantId: string,
  stripeFields: {
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    stripeSubscriptionStatus: string;
    subscriptionPlan: SubscriptionPlan;
  },
): Promise<void> {
  const { shouldResetMode, planChanged } = await uow.run(async (tx) => {
    // トランザクション内で最新のテナント状態を読み直す (呼び出し元のスナップショットに頼らない)
    const tenant = await tx.tenants.findById(tenantId);
    // 呼び出し元で存在確認済みだが、念のためここでも安全側 (何もしない) に倒す
    if (!tenant) return { shouldResetMode: false, planChanged: false };
    // /code-review ultra 指摘対応 (2026-07-13): 監査ログに残すため、更新前のプランを保持しておく
    const previousPlan = tenant.subscriptionPlan;
    // Stripe 連携情報とプランを反映する
    await tx.tenants.updateStripeSubscription(tenantId, stripeFields);
    // 現在 Pro モードで運用中かつ、新プランが Pro モードを許可しないときだけモードを戻す
    const shouldReset = tenant.mode === 'pro' && !isProModeAllowed(stripeFields.subscriptionPlan);
    if (shouldReset) {
      // Pro 専用機能を使えなくする (Lite モードへ強制的に戻す)
      await tx.tenants.updateMode(tenantId, 'lite');
    }
    return {
      shouldResetMode: shouldReset,
      planChanged: previousPlan !== stripeFields.subscriptionPlan,
    };
  });

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
): Promise<void> {
  // Stripe のサブスクリプションオブジェクトから必要なフィールドを取り出す
  const subscriptionId = subscriptionObject['id'] as string | undefined;
  const customerId = subscriptionObject['customer'] as string | undefined;
  const status = subscriptionObject['status'] as string | undefined;
  // items.data[0].price.id で Price ID を取得する (最初のアイテムのみ使用)
  const items = subscriptionObject['items'] as
    | { data?: Array<{ price?: { id?: string } }> }
    | undefined;
  const priceId = items?.data?.[0]?.price?.id ?? '';
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
  const plan = stripeStatusToPlan(status, priceId);

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

  // テナントのサブスク情報を更新する (ダウングレードなら Pro モードも同時に強制解除する)
  await applyPlanChange(tenantId, {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    stripeSubscriptionStatus: status,
    subscriptionPlan: nextPlan,
  });
}

// サブスクリプション削除を処理する: free プランに降格してキャンセル状態を記録する
async function handleSubscriptionDeleted(
  subscriptionObject: Record<string, unknown>,
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
  await applyPlanChange(tenantId, {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    stripeSubscriptionStatus: 'canceled', // Stripe の deleted イベントは canceled 扱いにする
    subscriptionPlan: nextPlan, // Enterprise 以外は free に降格
  });
}
