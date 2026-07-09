'use server';

// Phase 4 課金: Stripe Customer Portal セッションを作成する Server Action。
// 管理者が「プランを管理」ボタンを押したときに呼び出され、
// Stripe の顧客ポータル (請求書確認・プラン変更・解約) へリダイレクトする URL を返す。
// docs/smb-dx-pivot-plan.md §6「マネタイズ・販売戦略」

// セッション取得
import { auth } from '@/lib/auth';
// テナントリポジトリ
import { repos } from '@/data';
// Stripe クライアント
import { getStripeClient } from '@/lib/stripe';
// アプリの外部公開 URL を取得するヘルパー
import { resolveAppBaseUrl } from '@/lib/app-url';
// 連打防止のための共通レート制限ヘルパー
import { checkRateLimit } from '@/lib/rate-limit';

// ポータルセッション作成の戻り値型
interface CreatePortalResult {
  url?: string; // Stripe Customer Portal の URL (成功時)
  error?: string; // エラーメッセージ (失敗時)
}

// Stripe Customer Portal セッションを作成して管理ページ URL を返す
export async function createPortalSession(): Promise<CreatePortalResult> {
  // セッション取得と認証チェック
  const session = await auth();
  // 未ログインまたは tenantId 不在は拒否
  if (!session?.user?.id || !session.user.tenantId) {
    return { error: '認証が必要です' };
  }
  // 管理者のみが課金ポータルにアクセスできる
  if (session.user.role !== 'admin') {
    return { error: 'この操作は管理者のみ実行できます' };
  }

  // Stripe Customer Portal セッション作成の連打を抑制する (60 秒あたり 10 回まで、テナント単位。
  // create-checkout-session.ts と同じ上限・キー粒度の方針。Stripe API 呼び出しコスト対策)
  const rateLimitError = checkRateLimit(`stripe-portal-session:${session.user.tenantId}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitError) return { error: rateLimitError };

  // テナントの Stripe Customer ID を取得する
  const tenant = await repos.tenants.findById(session.user.tenantId);
  if (!tenant?.stripeCustomerId) {
    // Stripe Customer ID がない場合はポータルを開けない (有料プランに未登録)
    return { error: '課金情報が見つかりません。まず有料プランにご登録ください。' };
  }

  // アプリの公開 URL を取得する (ポータルからの戻り先に必要)
  const baseUrl = resolveAppBaseUrl();

  try {
    // Stripe クライアントを取得する
    const stripe = getStripeClient();

    // Customer Portal セッションを作成する
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: tenant.stripeCustomerId, // テナントに紐づく Stripe Customer ID
      // ポータル操作後の戻り先 (設定ページの課金セクション)
      return_url: `${baseUrl}/settings`,
    });

    // Stripe Customer Portal の URL を返す
    return { url: portalSession.url };
  } catch (err) {
    // Stripe API エラーは汎用メッセージにする (内部詳細を漏らさない §9)
    console.error('[create-portal-session] Stripe エラー:', err);
    return { error: 'Stripe ポータルの作成に失敗しました。しばらく後にもう一度お試しください。' };
  }
}
