'use server';

// Phase 4 課金: Stripe Customer Portal セッションを作成する Server Action。
// 管理者が「プランを管理」ボタンを押したときに呼び出され、
// Stripe の顧客ポータル (請求書確認・プラン変更・解約) へリダイレクトする URL を返す。
// docs/smb-dx-pivot-plan.md §6「マネタイズ・販売戦略」

// 「ログイン済み・admin・自テナント」を検証する共有ゲート (create-location.ts 等と同じ
// 非throw系アクションで共有する。§6 DRY: 個別に複製していた認証+ロールブロックを集約)
import { assertTenantAdmin } from '@/lib/tenant-admin-gate';
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
  // 共有ゲートで「ログイン済み・admin・自テナント」をまとめて検証する
  const gate = await assertTenantAdmin();
  // ゲート不通過ならその理由をそのまま返す
  if (!gate.ok) return { error: gate.error };
  // 検証済みの tenantId (セッション由来)
  const tenantId = gate.tenantId;

  // テナントの Stripe Customer ID を取得する
  const tenant = await repos.tenants.findById(tenantId);
  if (!tenant?.stripeCustomerId) {
    // Stripe Customer ID がない場合はポータルを開けない (有料プランに未登録)
    return { error: '課金情報が見つかりません。まず有料プランにご登録ください。' };
  }

  // Stripe Customer Portal セッション作成 (実際に Stripe API を呼ぶ直前) の連打を抑制する
  // (60 秒あたり 10 回まで、テナント単位。create-checkout-session.ts と同じ上限・キー粒度の
  // 方針)。Stripe Customer ID 未登録などバリデーション段階で弾かれるリクエストは Stripe API を
  // 一切呼ばないため、ここより前ではクォータを消費させない
  const rateLimitError = checkRateLimit(`stripe-portal-session:${tenantId}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitError) return { error: rateLimitError };

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
