// Phase 4 課金: Stripe SDK クライアントのシングルトン生成モジュール。
// docs/smb-dx-pivot-plan.md §6「マネタイズ・販売戦略」— Free / Standard / Pro の 3 段階課金
// STRIPE_SECRET_KEY は環境変数から取得し、未設定なら起動を失敗させる (fail-closed 設計)。

// Stripe SDK をインポート (npm install stripe 済み)
import Stripe from 'stripe';

// Stripe API の「メジャー版」。Stripe の API バージョンは `<日付>.<メジャー名>` という形をしていて、
// **同じメジャー名のあいだは後方互換が保たれる** (日付だけが進む更新は互換のある変更)。
// 破壊的変更が入るのはメジャー名が変わるときなので、見張るべきなのは日付ではなくこちら。
//
// このモジュールで唯一「人が手で書く」バージョン値で、`tests/stripe-api-version-guard.test.ts` が
// SDK の申告するメジャー版と突き合わせる。Stripe が次のメジャーへ進んだ SDK が Dependabot で
// 入ってきた時点でそのテストが落ち、移行の要否を人が判断する入口になる (日常の日付更新では鳴らない)。
export const EXPECTED_STRIPE_MAJOR_API_VERSION = 'dahlia';

// Stripe へ送る API バージョン。**SDK が申告する値をそのまま使い、手で書き写さない。**
//
// なぜ日付入りのリテラルを直書きしないのか (以前は直書きしていた):
//   SDK の型は `apiVersion?: Stripe.LatestApiVersion` で、これは「その SDK が生成された
//   ただ 1 つの日付版」を指す**単一のリテラル型**。つまり別の版を書くことは型が許さないので、
//   直書きのリテラルは「版を固定する」働きを最初から持っていなかった。実際に版を決めていたのは
//   package.json / package-lock.json でピン留めした **SDK のバージョン**の方。
//   残っていた効果は「stripe を上げるたびに typecheck だけが落ち、node_modules の中の値を人が
//   書き写して直す」という手間だけで、これは §6 が禁じる「写しを持つ」形そのものだった
//   (実例: Dependabot の stripe 22.5.0 → 22.6.0 で `npm run typecheck` が TS2322 で落ちた)。
//
// 型注釈は「この定数が満たすべき契約 (= `apiVersion` に渡せる型)」の記録として残している。
// **ただしこれは上流の型が緩むことへの防御にはならない**: `LatestApiVersion` は
// `typeof ApiVersion` の別名で、`API_VERSION` の型も同じ `typeof ApiVersion` なので、
// 上流が `ApiVersion` を素の `string` へ広げると**代入の両側が同時に広がって通ってしまう**。
// 型が緩んだ場合に実際に効くのは下のメジャー版ガード (`EXPECTED_STRIPE_MAJOR_API_VERSION` を
// `tests/stripe-api-version-guard.test.ts` が実行時の文字列と突き合わせる) の方で、
// あちらは型ではなく値を見るため上流の型定義に左右されない。
const STRIPE_API_VERSION: Stripe.LatestApiVersion = Stripe.API_VERSION;

// Stripe シークレットキーを環境変数から取得する (サーバー側のみで参照 — クライアントに漏らさない)
function getStripeSecretKey(): string {
  // 未設定なら起動時に問題を顕在化させる (fail-closed: 不明な状態で課金処理をしない)
  // 値は trim する (STRIPE_PRICE_* と同じ理由: secret マネージャ経由で末尾に改行が混ざると、
  // 署名計算や API 呼び出しが全滅する。しかもこちらは再送で回復できない壊れ方になる)
  const key = process.env.STRIPE_SECRET_KEY?.trim();
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

/**
 * 送ろうとしている API バージョンが前提を満たすことを、**本番の実行経路でも**確かめる。
 *
 * なぜテストだけに任せないのか: `EXPECTED_STRIPE_MAJOR_API_VERSION` の宣言が
 * 「テストからしか読まれない飾り」になると、テストを流さずにビルド・デプロイした場合に
 * **想定していないメジャーの API を黙って話し始める**。課金は誤判定がそのまま権限と請求に
 * 直結する領域なので、不明なら止める側に倒す (§9 fail-closed。このモジュールが
 * `STRIPE_SECRET_KEY` 未設定でも起動を失敗させているのと同じ扱い)。
 *
 * モジュール読み込み時ではなく**生成時に**呼ぶのは、`STRIPE_PRICE_IDS` など SDK を使わない
 * export だけを import する経路を巻き添えで落とさないため (現時点ではそういう利用者は無く、
 * `@/lib/stripe` の import 元 3 つ — Webhook ルート / チェックアウト / 顧客ポータル — は
 * いずれも `getStripeClient()` を呼ぶ。つまり**今はどの経路もこの検査を通る**)。
 */
function assertApiVersionSupported(apiVersion: string | undefined): void {
  // 値が空 (指定なし・undefined 相当) なら、版を固定できていないので止める
  if (!apiVersion) {
    throw new Error(
      '[stripe] 送信する API バージョンを解決できません。' +
        'クライアント生成時の apiVersion 指定と stripe SDK の API_VERSION を確認してください。',
    );
  }
  // 想定したメジャーでなければ止める。SDK が次のメジャーへ進んだのに移行を確認していない状態
  if (!apiVersion.endsWith(`.${EXPECTED_STRIPE_MAJOR_API_VERSION}`)) {
    throw new Error(
      `[stripe] Stripe API のメジャー版が想定 (${EXPECTED_STRIPE_MAJOR_API_VERSION}) と異なります: ` +
        `${apiVersion}。破壊的変更の有無を確認し、移行してから ` +
        'EXPECTED_STRIPE_MAJOR_API_VERSION を更新してください。',
    );
  }
}

// Stripe クライアントを取得する関数 (ホットリロード対策のシングルトン)
export function getStripeClient(): Stripe {
  // 開発環境ではホットリロードのたびに新インスタンスが作られるのを防ぐ
  if (!global._stripeClient) {
    // クライアントへ渡すオプションを**先に組み立てる**。
    // こうして「実際に渡すオブジェクト」を検査対象にするのが要点で、別の定数に差し替えられても、
    // 後ろのスプレッドで上書きされても、指定ごと消されても、下の検査がその結果を見る。
    // (組み立てずに定数だけを検査すると、渡している値とは別のものを確かめることになる)
    const clientOptions: Stripe.StripeConfig = {
      // SDK の申告値をそのまま渡す (互換性は SDK の版ピンで担保)。
      // **この指定は現時点では送信内容を変えない** — SDK は
      // `version: props.apiVersion || DEFAULT_API_VERSION` で、その既定値が `Stripe.API_VERSION`
      // そのものだから。それでも明示するのは防御的な意味で、将来 SDK の既定値が `API_VERSION` と
      // 食い違う形に変わったとき (アカウント既定版を使う等)、送る版が意図から外れるのを防ぐ
      apiVersion: STRIPE_API_VERSION,
    };
    // 実際に渡す値が前提を満たすことを確かめる (満たさなければクライアントを作らない)
    assertApiVersionSupported(clientOptions.apiVersion);
    // 初回のみインスタンスを生成してグローバルにキャッシュ
    global._stripeClient = new Stripe(getStripeSecretKey(), clientOptions);
  }
  return global._stripeClient;
}

// 有料プランの優先順位 (上位プランが先)。**プラン判定に関する唯一の真実の源**で、
// pickKnownPriceId (どの Price ID を判定に使うか) と stripeStatusToPlan (どのプランと見なすか)
// の両方がこの並びを回す。片方だけに順序を書き写すと、プランを増やしたときに
// 「選んだ ID を別の関数が下位プランと判定する」形で黙って降格する (§6 一元管理)。
//
// 下の KnownPriceIds をこの配列から導出しているのが要点で、プランを足すとき配列への追記を
// 忘れると STRIPE_PRICE_IDS 側に余分なキーが残って**型チェックが落ちる**。
// 「表に載せ忘れたプランが黙って free 扱いになる」形の漏れを型で塞いでいる。
const PAID_PLAN_PRIORITY = ['pro', 'standard'] as const;

// 有料プラン名 (Stripe の Price ID で判定できるもの)。free は Price ID を持たないので含まない
export type PaidPlan = (typeof PAID_PLAN_PRIORITY)[number];

// プラン判定に使う Price ID の対応表の型。プラン判定に関わる関数はこれを引数で受け取り、
// モジュール内の定数を直接読まない (参照元が 2 つに割れると、片方だけ差し替えたときに
// 「選んだ ID を別の関数が未知と判定する」形で黙って壊れる。§6 一元管理)
export type KnownPriceIds = { readonly [P in PaidPlan]: string };

// プラン ID マッピング: Stripe の Price ID を環境変数から取得する。
// Price ID は Stripe ダッシュボードで各プランのサブスク価格を作成した際に発行される。
// 未設定なら空文字列になる。チェックアウト経路は Server Action 側で弾き、Webhook 経路は
// 「プランを解決できないイベントは適用しない」形で扱う (src/app/api/webhooks/stripe/route.ts)。
// 値は trim してから使う。secret マネージャや `docker --env-file` 経由だと末尾に改行や空白が
// 混ざることがあり、そのままだと Stripe から届く本物の Price ID と一致せず、**全課金テナントの
// イベントが解決不能**になる (§9 環境変数も検証する)。
export const STRIPE_PRICE_IDS: KnownPriceIds = {
  // スタンダードプラン: 月額 4,980 円 (Lite モードフル + メール取り込み)
  standard: (process.env.STRIPE_PRICE_STANDARD ?? '').trim(),
  // プロプラン: 月額 14,800 円 (Pro モード + 監査ログ + LINE 連携)
  pro: (process.env.STRIPE_PRICE_PRO ?? '').trim(),
} as const;

// サブスクリプションに含まれる Price ID 群から、プラン判定に使う 1 件を選ぶヘルパー。
//
// なぜ「先頭の 1 件」で済ませないのか: Stripe のサブスクリプションは複数の item を持てる
// (座席の追加購入・従量課金のアドオン等)。items の並び順は保証されないので、先頭を無条件に
// 使うとアドオンの Price ID を拾ってしまい、本来 Pro のテナントが「未知の Price ID」として
// 扱われる。
//
// 選び方は次の 2 段階:
//   1. PAID_PLAN_PRIORITY の順 (pro → standard) に既知の Price ID を探す。上位プランを
//      先に見るのは、standard と pro の item を同時に持つサブスク (プラン変更中の按分など) で
//      **配列順によって pro→standard へ降格しない**ようにするため。
//   2. どれとも一致しなければ、空でない最初の値を返す (原因調査でどの ID が来ていたかを
//      見せるため。先頭固定にすると、price が展開されていない item が先頭に来ただけで
//      実際に届いた ID が消える)。
//
// 対応表 (knownPriceIds) をモジュール内の STRIPE_PRICE_IDS から読まず引数で受け取るのは、
// この関数を純粋関数に保ち、ユニットテストから対応表を差し替えられるようにするため。
export function pickKnownPriceId(
  priceIds: readonly string[],
  knownPriceIds: KnownPriceIds,
): string {
  // 空文字 (対応表未設定の目印・price が展開されていない item) は候補から外す
  const candidates = priceIds.filter((id) => id !== '');
  // 上位プランから順に、対応表と一致する Price ID を探す
  for (const plan of PAID_PLAN_PRIORITY) {
    const hit = candidates.find((id) => id === knownPriceIds[plan]);
    if (hit !== undefined) return hit;
  }
  // 一致が無ければ、空でない最初の値 (それも無ければ空文字) を返す
  return candidates[0] ?? '';
}

// Stripe Webhook の署名検証に使う Endpoint Secret (Webhook 設定画面で発行)
// リクエスト本文が Stripe から送られたものと同一かを HMAC 署名で検証するために必要
export function getStripeWebhookSecret(): string {
  // 値は trim する (末尾の改行が混ざると HMAC が全件不一致になり、全イベントが 400 になる)
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
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
): 'free' | PaidPlan {
  // サブスク status が有効 (active | trialing) のときだけプランを昇格する
  if (!isActiveSubscriptionStatus(status)) {
    // キャンセル・支払い遅延 (past_due | canceled 等) は free に降格
    return 'free';
  }
  // Price ID が空文字の場合は環境変数未設定またはデータ不備なので free にフォールバック
  // (空文字同士が一致して意図せず pro/standard に昇格するのを防ぐ)
  if (!priceId) return 'free';
  // 同じ Price ID が複数のプランに割り当てられていたら、どちらとも決められないので free に倒す。
  // (両方の環境変数に同じ値を入れる設定ミスで、Standard 契約者に Pro 権限が渡るのを防ぐ。
  //  戻り値が free になることで、Webhook 側の「解決できないイベントは適用しない」経路に乗る)
  const matched = PAID_PLAN_PRIORITY.filter((plan) => priceId === knownPriceIds[plan]);
  if (matched.length > 1) return 'free';
  // 有効なサブスクの Price ID でプランを判定する (順序は pickKnownPriceId と同じ表を回す)
  return matched[0] ?? 'free';
}
