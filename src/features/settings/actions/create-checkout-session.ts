'use server';

// Phase 4 課金: Stripe Checkout セッションを作成する Server Action。
// ユーザーが「アップグレード」ボタンを押したときに呼び出され、
// Stripe の支払いページへリダイレクトさせる URL を返す。
// docs/smb-dx-pivot-plan.md §6「マネタイズ・販売戦略」

// セッション取得
import { auth } from '@/lib/auth';
// テナントリポジトリ
import { repos } from '@/data';
// Stripe クライアントと Price ID マッピング
import { getStripeClient, STRIPE_PRICE_IDS } from '@/lib/stripe';
// アプリの外部公開 URL を取得するヘルパー
import { resolveAppBaseUrl } from '@/lib/app-url';
// 課金プラン型
import type { SubscriptionPlan } from '@/domain/types';

// チェックアウトセッション作成の戻り値型
interface CreateCheckoutResult {
  url?: string; // Stripe Checkout の支払いページ URL (成功時)
  error?: string; // エラーメッセージ (失敗時)
}

// Stripe Checkout セッションを作成して支払いページ URL を返す
export async function createCheckoutSession(
  targetPlan: SubscriptionPlan,
): Promise<CreateCheckoutResult> {
  // セッション取得と認証チェック
  const session = await auth();
  // 未ログインまたは tenantId 不在は拒否
  if (!session?.user?.id || !session.user.tenantId) {
    return { error: '認証が必要です' };
  }
  // 管理者のみが課金プランを変更できる
  if (session.user.role !== 'admin') {
    return { error: 'この操作は管理者のみ実行できます' };
  }

  // Free プランへのアップグレードはチェックアウト不要 (Webhook のキャンセル処理が担当)
  if (targetPlan === 'free') {
    return { error: 'Free プランへの変更はサブスクリプション解約から行ってください' };
  }

  // 対象プランの Stripe Price ID を取得する
  const priceId = targetPlan === 'standard' ? STRIPE_PRICE_IDS.standard : STRIPE_PRICE_IDS.pro;
  // Price ID が設定されていない場合は課金機能未設定として拒否
  if (!priceId) {
    return {
      error: `Stripe Price ID が設定されていません (STRIPE_PRICE_${targetPlan.toUpperCase()} 環境変数を確認してください)`,
    };
  }

  // テナント情報を取得して既存の Stripe Customer ID を確認する
  const tenant = await repos.tenants.findById(session.user.tenantId);
  if (!tenant) {
    return { error: 'テナント情報の取得に失敗しました' };
  }

  // アプリの公開 URL を取得する (Stripe の success/cancel URL に必要)
  const baseUrl = resolveAppBaseUrl();

  try {
    // Stripe クライアントを取得する
    const stripe = getStripeClient();

    // Stripe Checkout セッションを作成する
    const checkoutSession = await stripe.checkout.sessions.create({
      // 支払い方式: サブスクリプション (定期課金)
      mode: 'subscription',
      // 選択したプランの Price ID を商品として指定する
      line_items: [{ price: priceId, quantity: 1 }],
      // 支払い成功後のリダイレクト先 (設定ページの課金セクションに戻る)
      success_url: `${baseUrl}/settings?billing=success`,
      // ユーザーがキャンセルした場合のリダイレクト先
      cancel_url: `${baseUrl}/settings?billing=canceled`,
      // 既存の Stripe Customer がいればそちらに紐づける (なければ新規作成される)
      ...(tenant.stripeCustomerId ? { customer: tenant.stripeCustomerId } : {}),
      // Webhook でテナントを特定するためにメタデータを埋め込む
      // Stripe のメタデータは文字列のキーバリューペアのみ使用可
      subscription_data: {
        metadata: {
          tenantId: session.user.tenantId, // Webhook でテナントを特定するためのキー
        },
      },
      // 顧客のメールアドレスを事前入力してフォームを簡略化する
      customer_email: session.user.email ?? undefined,
    });

    // Stripe Checkout の支払いページ URL を返す
    if (!checkoutSession.url) {
      return { error: 'Stripe Checkout URL の取得に失敗しました' };
    }
    return { url: checkoutSession.url };
  } catch (err) {
    // Stripe API エラーは内部詳細を返さず汎用メッセージにする (セキュリティ §9)
    console.error('[create-checkout-session] Stripe エラー:', err);
    return { error: 'Stripe Checkout の作成に失敗しました。しばらく後にもう一度お試しください。' };
  }
}
