// Phase 4 課金: Stripe SDK クライアントのシングルトン生成モジュール。
// docs/smb-dx-pivot-plan.md §6「マネタイズ・販売戦略」— Free / Standard / Pro の 3 段階課金
// STRIPE_SECRET_KEY は環境変数から取得し、未設定なら起動を失敗させる (fail-closed 設計)。

// Stripe SDK をインポート (npm install stripe 済み)
import Stripe from 'stripe';

// Stripe の API バージョン (後方互換を固定するため定数化)
// Stripe は定期的に API バージョンを更新するため、明示固定して意図しない挙動変化を防ぐ
// インストール済み stripe SDK が対応するバージョンに合わせる (npm ls stripe で確認)
const STRIPE_API_VERSION = '2026-07-29.dahlia' as const;

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

// プラン判定に使う Price ID の対応表の型。プラン判定に関わる関数はこれを引数で受け取り、
// モジュール内の定数を直接読まない (参照元が 2 つに割れると、片方だけ差し替えたときに
// 「選んだ ID を別の関数が未知と判定する」形で黙って壊れる。§6 一元管理)
export interface KnownPriceIds {
  readonly standard: string;
  readonly pro: string;
}

// プラン ID マッピング: Stripe の Price ID を環境変数から取得する。
// Price ID は Stripe ダッシュボードで各プランのサブスク価格を作成した際に発行される。
// 未設定なら空文字列になる。チェックアウト経路は Server Action 側で弾き、Webhook 経路は
// 「プランを解決できないイベントは適用しない」形で扱う (src/app/api/webhooks/stripe/route.ts)。
export const STRIPE_PRICE_IDS: KnownPriceIds = {
  // スタンダードプラン: 月額 4,980 円 (Lite モードフル + メール取り込み)
  standard: process.env.STRIPE_PRICE_STANDARD ?? '',
  // プロプラン: 月額 14,800 円 (Pro モード + 監査ログ + LINE 連携)
  pro: process.env.STRIPE_PRICE_PRO ?? '',
} as const;

// サブスクリプションに含まれる Price ID 群から、プラン判定に使う 1 件を選ぶヘルパー。
//
// なぜ「先頭の 1 件」で済ませないのか: Stripe のサブスクリプションは複数の item を持てる
// (座席の追加購入・従量課金のアドオン等)。items の並び順は保証されないので、先頭を無条件に
// 使うとアドオンの Price ID を拾ってしまい、本来 Pro のテナントが「未知の Price ID」として
// 扱われる。既知のプランに対応する ID を優先して探し、無ければ先頭を返す
// (見つからない場合も素の値を返すのは、原因調査でどの ID が来ていたかを見せるため)。
//
// 対応表 (knownPriceIds) をモジュール内の STRIPE_PRICE_IDS から読まず引数で受け取るのは、
// この関数を純粋関数に保ち、ユニットテストから対応表を差し替えられるようにするため。
export function pickKnownPriceId(
  priceIds: readonly string[],
  knownPriceIds: KnownPriceIds,
): string {
  // 空文字 (対応表未設定の目印・price が展開されていない item) は候補から外す
  const candidates = priceIds.filter((id) => id !== '');
  // Pro を先に探す。standard と pro の item を同時に持つサブスク (プラン変更中の按分など) で
  // 配列順によって pro→standard に降格しないよう、上位プランを優先する
  // (stripeStatusToPlan も pro を先に判定しており、その規則をここでも守る)
  const pro = candidates.find((id) => id === knownPriceIds.pro);
  if (pro !== undefined) return pro;
  // 次に Standard を探す
  const standard = candidates.find((id) => id === knownPriceIds.standard);
  if (standard !== undefined) return standard;
  // どれとも一致しなければ、空でない最初の値を返す (原因調査でどの ID が来ていたかを見せるため。
  // 先頭固定にすると、price が展開されていない item が先頭に来ただけで実際の ID が消える)
  return candidates[0] ?? '';
}

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

// Stripe のサブスクリプション status が「課金が有効」と言える状態かを判定するヘルパー。
// active (支払い済み) と trialing (試用期間中) だけを有効とみなし、past_due / canceled /
// incomplete などはすべて無効として扱う。
//
// なぜ独立した関数にしているか: この「有効な状態とは何か」という規則は
// stripeStatusToPlan (プラン判定) と Webhook ルート (未知の Price ID の検知) の
// 2 か所で必要になる。片方に書き写すと、規則を変えたときにもう片方だけ古いままになり、
// 「有効なはずのサブスクを無効と誤判定する」形で黙ってずれる (§6 DRY)。
export function isActiveSubscriptionStatus(status: string): boolean {
  // active か trialing のどちらかであれば課金が有効な状態とみなす
  return status === 'active' || status === 'trialing';
}

// Stripe のサブスクリプション status 文字列を SubscriptionPlan にマップするヘルパー
// Stripe Webhook の customer.subscription.updated / deleted イベントで使用する。
// 戻り値に 'enterprise' は含めない: Enterprise は個別見積で Stripe チェックアウトを経由せず
// 運用が手動設定するため、Stripe イベント経由でこのプランへ昇格/降格させることはない。
//
// なお「有効なサブスクなのに free になった」= Price ID が空か未知、という異常は
// この関数からは区別できない (戻り値がどちらも 'free' のため)。呼び出し側で検知して
// ログに出す責務があり、Webhook ルートの handleSubscriptionUpsert がそれを行う。
// ここに console を持ち込まないのは、この関数を純粋関数のまま保つため (§10 / テスト容易性)。
export function stripeStatusToPlan(
  status: string,
  priceId: string,
  knownPriceIds: KnownPriceIds,
): 'free' | 'standard' | 'pro' {
  // サブスク status が有効 (active | trialing) のときだけプランを昇格する
  if (!isActiveSubscriptionStatus(status)) {
    // キャンセル・支払い遅延 (past_due | canceled 等) は free に降格
    return 'free';
  }
  // Price ID が空文字の場合は環境変数未設定またはデータ不備なので free にフォールバック
  // (空文字同士が一致して意図せず pro/standard に昇格するのを防ぐ)
  if (!priceId) return 'free';
  // 有効なサブスクの Price ID でプランを判定する
  if (priceId === knownPriceIds.pro) return 'pro';
  if (priceId === knownPriceIds.standard) return 'standard';
  // 未知の Price ID は free にフォールバック (fail-safe)
  return 'free';
}
