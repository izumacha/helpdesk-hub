// Phase 4 課金: Stripe SDK クライアントのシングルトン生成モジュール。
// docs/smb-dx-pivot-plan.md §6「マネタイズ・販売戦略」— Free / Standard / Pro の 3 段階課金
// STRIPE_SECRET_KEY は環境変数から取得し、未設定なら起動を失敗させる (fail-closed 設計)。

// Stripe SDK をインポート (npm install stripe 済み)
import Stripe from 'stripe';

// Stripe の API バージョン (後方互換を固定するため定数化)
// Stripe は定期的に API バージョンを更新するため、明示固定して意図しない挙動変化を防ぐ
// インストール済み stripe SDK が対応するバージョンに合わせる (npm ls stripe で確認)
const STRIPE_API_VERSION = '2026-05-27.dahlia' as const;

// Stripe シークレットキーを環境変数から取得する (サーバー側のみで参照 — クライアントに漏らさない)
function getStripeSecretKey(): string {
  // 未設定なら起動時に問題を顕在化させる (fail-closed: 不明な状態で課金処理をしない)
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      '[stripe] STRIPE_SECRET_KEY が設定されていません。環境変数を確認してください。',
    );
  }
  return key;
}

// Stripe クライアントのシングルトンインスタンス。
// Next.js のホットリロードで毎回再生成されないよう、グローバルスコープにキャッシュする。
// 参考: https://nextjs.org/docs/app/building-your-application/configuring/environment-variables
declare global {
  // グローバルシングルトン用の型拡張 (TypeScript の declare global では var が必要)
  var _stripeClient: Stripe | undefined;
}

// Stripe クライアントを取得する関数 (ホットリロード対策のシングルトン)
export function getStripeClient(): Stripe {
  // 開発環境ではホットリロードのたびに新インスタンスが作られるのを防ぐ
  if (!global._stripeClient) {
    // 初回のみインスタンスを生成してグローバルにキャッシュ
    global._stripeClient = new Stripe(getStripeSecretKey(), {
      apiVersion: STRIPE_API_VERSION, // API バージョンを固定して安定性を確保
    });
  }
  return global._stripeClient;
}

// プラン ID マッピング: Stripe の Price ID を環境変数から取得する。
// Price ID は Stripe ダッシュボードで各プランのサブスク価格を作成した際に発行される。
// 未設定の場合は空文字列を返すが、課金処理実行前に Server Action 側でチェックする。
export const STRIPE_PRICE_IDS = {
  // スタンダードプラン: 月額 4,980 円 (Lite モードフル + メール取り込み)
  standard: process.env.STRIPE_PRICE_STANDARD ?? '',
  // プロプラン: 月額 14,800 円 (Pro モード + 監査ログ + LINE 連携)
  pro: process.env.STRIPE_PRICE_PRO ?? '',
} as const;

// Stripe Webhook の署名検証に使う Endpoint Secret (Webhook 設定画面で発行)
// リクエスト本文が Stripe から送られたものと同一かを HMAC 署名で検証するために必要
export function getStripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      '[stripe] STRIPE_WEBHOOK_SECRET が設定されていません。Stripe ダッシュボードの Webhook 設定を確認してください。',
    );
  }
  return secret;
}

// Stripe のサブスクリプション status 文字列を SubscriptionPlan にマップするヘルパー
// Stripe Webhook の customer.subscription.updated / deleted イベントで使用する。
// 戻り値に 'enterprise' は含めない: Enterprise は個別見積で Stripe チェックアウトを経由せず
// 運用が手動設定するため、Stripe イベント経由でこのプランへ昇格/降格させることはない。
export function stripeStatusToPlan(
  status: string,
  priceId: string,
): 'free' | 'standard' | 'pro' {
  // サブスク status が有効 (active | trialing) のときだけプランを昇格する
  if (status !== 'active' && status !== 'trialing') {
    // キャンセル・支払い遅延 (past_due | canceled 等) は free に降格
    return 'free';
  }
  // Price ID が空文字の場合は環境変数未設定またはデータ不備なので free にフォールバック
  // (空文字同士が一致して意図せず pro/standard に昇格するのを防ぐ)
  if (!priceId) return 'free';
  // 有効なサブスクの Price ID でプランを判定する
  if (priceId === STRIPE_PRICE_IDS.pro) return 'pro';
  if (priceId === STRIPE_PRICE_IDS.standard) return 'standard';
  // 未知の Price ID は free にフォールバック (fail-safe)
  return 'free';
}
