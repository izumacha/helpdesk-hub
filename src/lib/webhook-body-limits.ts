// 受信 Webhook 3 経路 (LINE 取り込み / メール取り込み / Stripe 課金) が受け付ける
// リクエストボディの最大バイト数。
//
// なぜ route ファイルではなくここに置くのか:
// Next.js の Route Handler は既知のエクスポート名 (GET/POST/runtime 等) しか許さないため、
// route.ts から定数を export できない。route とテストが同じ定義を参照する (= 片方だけ値を
// 変えたら気付ける) ようにするには、両者から import できる場所へ出す必要がある。
// SSO ACS (`SSO_ACS_MAX_BODY_BYTES` in sso-rate-limit.ts) とマジックリンクのコールバック
// (`MAGIC_LINK_CALLBACK_MAX_BODY_BYTES` in magic-link.ts) は、その経路の他の共有定数と
// 同居できる置き場が既にあったのでそちらに置いている。ここは「置き場が無かった 3 経路」を
// まとめる場所で、3 つを並べておくと値の妥当性 (この経路だけ極端に緩くないか) を
// 見比べて確認できる利点もある。
//
// 実際の読み取り (ストリームを上限つきで読み、超えた時点で打ち切る) は
// `request-body-limit.ts` の `readBodyWithinByteLimit` / `readFormWithinByteLimit` が担う。
// 上限値をここで決め、読み取り方法をあちらに集約する分担にしている。
//
// 値を決めるときの注意: 読み取り中はバッファを伸ばす瞬間だけ新旧が並ぶので約 1.5 倍、
// さらに formData() でパースするとフィールド値のコピーがもう 1 つできる
// (詳細は request-body-limit.ts 冒頭の「メモリの目安」)。

// LINE Webhook (`POST /api/inbound/line`) の上限 (256KB)。
// LINE の Webhook ペイロードはテキストメッセージのメタデータだけで画像バイト列を含まない
// (画像は Content API から別途取得する) ため小さく、1 リクエストのイベント数も
// MAX_EVENTS_PER_REQUEST で別途抑えている。未認証で到達できる経路なので短めに絞る。
export const LINE_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

// メール取り込み (`POST /api/inbound/email`) の上限 (25MB)。
// 一般的なメール送信サービスの添付上限が 25MB 前後で、multipart の本文には添付ファイルの
// バイト列がそのまま乗るため、他の 2 経路より大幅に大きい。この経路だけは共有シークレット
// 認証を先に通過しないとボディ読み取りに到達しない (未認証では消費できない) ため、
// 大きい上限でも攻撃面は限定的。
export const INBOUND_EMAIL_MAX_BODY_BYTES = 25 * 1024 * 1024;

// Stripe Webhook (`POST /api/webhooks/stripe`) の上限 (1MB)。
// Stripe のイベント JSON は通常数十 KB で、明細行の多い invoice でも 1MB に届くことはまず無い
// (Stripe はコレクションを 10 件程度で切って has_more を返す)。一方で絞りすぎると正規イベントを
// 413 で弾き続け、Stripe が再送を諦めた時点でプラン状態が実際の課金とずれる (最悪、解約済みの
// テナントが Pro 機能を使い続ける) ため、SSO ACS と同じ 1MB の余裕を持たせる。
export const STRIPE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
