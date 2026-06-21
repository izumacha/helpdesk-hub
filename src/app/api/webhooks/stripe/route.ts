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
// データリポジトリ (テナント更新用)
import { repos } from '@/data';
// Stripe クライアントと設定ヘルパー
import { getStripeClient, getStripeWebhookSecret, stripeStatusToPlan } from '@/lib/stripe';

// Stripe Webhook が送ってくる主要イベント種別の定数 (typo 防止のため文字列リテラルを定数化)
const STRIPE_EVENT_SUBSCRIPTION_CREATED = 'customer.subscription.created';
const STRIPE_EVENT_SUBSCRIPTION_UPDATED = 'customer.subscription.updated';
const STRIPE_EVENT_SUBSCRIPTION_DELETED = 'customer.subscription.deleted';

// POST /api/webhooks/stripe — Stripe Webhook エンドポイント
export async function POST(request: Request): Promise<NextResponse> {
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
    return NextResponse.json({ error: 'リクエストボディの読み取りに失敗しました' }, { status: 400 });
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
  if (
    type === STRIPE_EVENT_SUBSCRIPTION_CREATED ||
    type === STRIPE_EVENT_SUBSCRIPTION_UPDATED
  ) {
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

// サブスクリプション作成・更新を処理する: テナントのプランと状態を最新に保つ
async function handleSubscriptionUpsert(subscriptionObject: Record<string, unknown>): Promise<void> {
  // Stripe のサブスクリプションオブジェクトから必要なフィールドを取り出す
  const subscriptionId = subscriptionObject['id'] as string | undefined;
  const customerId = subscriptionObject['customer'] as string | undefined;
  const status = subscriptionObject['status'] as string | undefined;
  // items.data[0].price.id で Price ID を取得する (最初のアイテムのみ使用)
  const items = subscriptionObject['items'] as { data?: Array<{ price?: { id?: string } }> } | undefined;
  const priceId = items?.data?.[0]?.price?.id ?? '';
  // メタデータから tenantId を取得する (チェックアウト時に metadata.tenantId として設定する)
  const metadata = subscriptionObject['metadata'] as Record<string, string> | undefined;
  const tenantId = metadata?.['tenantId'];

  // 必須フィールドが揃っていない場合はスキップ (不完全なデータで更新しない)
  if (!subscriptionId || !customerId || !status || !tenantId) {
    console.warn(
      '[stripe-webhook] サブスクリプションに必須フィールドが不足しています:',
      { subscriptionId, customerId, status, tenantId },
    );
    return;
  }

  // Stripe の状態と Price ID からプランを判定する
  const plan = stripeStatusToPlan(status, priceId);

  // テナントのサブスク情報を更新する (tenantId はメタデータ由来 = Stripe 署名検証済み)
  await repos.tenants.updateStripeSubscription(tenantId, {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    stripeSubscriptionStatus: status,
    subscriptionPlan: plan,
  });
}

// サブスクリプション削除を処理する: free プランに降格してキャンセル状態を記録する
async function handleSubscriptionDeleted(subscriptionObject: Record<string, unknown>): Promise<void> {
  // サブスクリプション ID と status を取得する
  const subscriptionId = subscriptionObject['id'] as string | undefined;
  const customerId = subscriptionObject['customer'] as string | undefined;
  // メタデータから tenantId を取得する
  const metadata = subscriptionObject['metadata'] as Record<string, string> | undefined;
  const tenantId = metadata?.['tenantId'];

  // 必須フィールドが揃っていない場合はスキップ
  if (!subscriptionId || !tenantId) {
    console.warn(
      '[stripe-webhook] 削除イベントに必須フィールドが不足しています:',
      { subscriptionId, tenantId },
    );
    return;
  }

  // サブスクリプション削除後は free に降格し、canceled 状態を記録する
  await repos.tenants.updateStripeSubscription(tenantId, {
    stripeCustomerId: customerId ?? undefined,
    stripeSubscriptionId: subscriptionId,
    stripeSubscriptionStatus: 'canceled', // Stripe の deleted イベントは canceled 扱いにする
    subscriptionPlan: 'free', // free プランに降格
  });
}
