'use server';

// Phase 4 課金: Stripe Checkout セッションを作成する Server Action。
// ユーザーが「アップグレード」ボタンを押したときに呼び出され、
// Stripe の支払いページへリダイレクトさせる URL を返す。
// docs/smb-dx-pivot-plan.md §6「マネタイズ・販売戦略」

// セッション取得 (customer_email のフォールバックに session.user.email が必要なため、
// ゲート通過後も引き続き利用する)
import { auth } from '@/lib/auth';
// 「ログイン済み・admin・自テナント」を検証する共有ゲート (create-location.ts 等と同じ
// 非throw系アクションで共有する。§6 DRY: 個別に複製していた認証+ロールブロックを集約)
import { assertTenantAdmin } from '@/lib/tenant-admin-gate';
// テナントリポジトリ
import { repos } from '@/data';
// Stripe クライアントと Price ID マッピング
import { getStripeClient, STRIPE_PRICE_IDS } from '@/lib/stripe';
// アプリの外部公開 URL を取得するヘルパー
import { resolveAppBaseUrl } from '@/lib/app-url';
// 課金プラン型
import type { SubscriptionPlan } from '@/domain/types';
// 連打防止のための共通レート制限ヘルパー
import { checkRateLimit } from '@/lib/rate-limit';
// targetPlan の許可リスト検証スキーマ (standard | pro のみ)
import { checkoutTargetPlanSchema } from '@/lib/validations/billing';

// チェックアウトセッション作成の戻り値型
interface CreateCheckoutResult {
  url?: string; // Stripe Checkout の支払いページ URL (成功時)
  error?: string; // エラーメッセージ (失敗時)
}

// Stripe Checkout セッションを作成して支払いページ URL を返す
export async function createCheckoutSession(
  targetPlan: SubscriptionPlan,
): Promise<CreateCheckoutResult> {
  // 共有ゲートで「ログイン済み・admin・自テナント」をまとめて検証する
  const gate = await assertTenantAdmin();
  // ゲート不通過ならその理由をそのまま返す
  if (!gate.ok) return { error: gate.error };
  // 検証済みの tenantId (セッション由来)
  const tenantId = gate.tenantId;
  // customer_email のフォールバックに使うメールアドレスを取得する (Auth.js v5 の auth() は
  // React の cache() でリクエスト単位にメモ化されるため、assertTenantAdmin() 内の呼び出しと
  // 合わせて二重に session を取得し直すコストは発生しない)
  const session = await auth();

  // Free プランへのアップグレードはチェックアウト不要 (Webhook のキャンセル処理が担当)
  if (targetPlan === 'free') {
    return { error: 'Free プランへの変更はサブスクリプション解約から行ってください' };
  }

  // Enterprise は個別見積で Stripe の自助チェックアウトを経由しない (運用が手動設定)。
  // ここで弾かないと下のフォールバックで誤って Pro の Price ID が使われてしまうため明示的に拒否する。
  if (targetPlan === 'enterprise') {
    return { error: 'Enterprise プランは個別見積です。お問い合わせください。' };
  }

  // Server Action は POST エンドポイントとして直接呼び出せるため、TypeScript の引数型
  // (SubscriptionPlan) はコンパイル時の契約に過ぎず実行時の保証にはならない。free/enterprise
  // 以外の未知の値が来た場合に下のフォールバックで誤って Pro の Price ID が使われないよう、
  // standard | pro の許可リストで検証する (§9 入力は信用しない)
  const planCheck = checkoutTargetPlanSchema.safeParse(targetPlan);
  if (!planCheck.success) {
    return { error: planCheck.error.issues[0]?.message ?? 'プランの指定が正しくありません' };
  }

  // 対象プランの Stripe Price ID を取得する (ここに来る時点で standard | pro に絞られている)
  const priceId = targetPlan === 'standard' ? STRIPE_PRICE_IDS.standard : STRIPE_PRICE_IDS.pro;
  // Price ID が設定されていない場合は課金機能未設定として拒否
  if (!priceId) {
    // 環境変数名はサーバーログのみに残し、クライアントには汎用メッセージを返す
    console.error(
      `[create-checkout-session] Stripe Price ID が未設定: STRIPE_PRICE_${targetPlan.toUpperCase()} 環境変数を確認してください`,
    );
    return { error: '課金機能の設定が完了していません。管理者にお問い合わせください。' };
  }

  // テナント情報を取得して既存の Stripe Customer ID を確認する
  const tenant = await repos.tenants.findById(tenantId);
  if (!tenant) {
    return { error: 'テナント情報の取得に失敗しました' };
  }

  // Stripe Checkout セッション作成 (実際に Stripe API を呼ぶ直前) の連打を抑制する
  // (60 秒あたり 10 回まで、テナント単位。create-location.ts 等と同じ上限・キー粒度の方針)。
  // targetPlan が無効・Price ID 未設定・テナント不明などバリデーション段階で弾かれる
  // リクエストは Stripe API を一切呼ばないため、ここより前ではクォータを消費させない
  const rateLimitError = checkRateLimit(`stripe-checkout-session:${tenantId}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitError) return { error: rateLimitError };

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
      // customer と customer_email は同時に指定できないため、排他的に渡す
      ...(tenant.stripeCustomerId
        ? { customer: tenant.stripeCustomerId } // 既存 Customer に紐づける
        : { customer_email: session?.user?.email ?? undefined }), // 新規 Customer のメール事前入力
      // Webhook でテナントを特定するためにメタデータを埋め込む
      // Stripe のメタデータは文字列のキーバリューペアのみ使用可
      subscription_data: {
        metadata: {
          tenantId, // Webhook でテナントを特定するためのキー
        },
      },
      // §8 リスク対策「IT導入補助金の審査要件 (インボイス対応)」。日本の適格請求書等保存方式
      // (インボイス制度) に対応するため、顧客の登録番号 (T+13桁) を Checkout 画面で収集できるように
      // する。任意入力扱い (required: 'never') とし、未登録の顧客の決済を妨げない
      tax_id_collection: { enabled: true },
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
