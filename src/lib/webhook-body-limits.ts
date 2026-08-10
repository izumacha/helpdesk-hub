// 受信 Webhook 3 経路 (LINE 取り込み / メール取り込み / Stripe 課金) が受け付ける
// リクエストボディの「受け入れ枠」— 最大バイト数と、既定では足りない経路の読み取り制限時間。
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
// 値を決めるときの注意: 読み取り中の一時コピーを含めて、本文サイズの 4 倍弱のメモリを
// 見込むこと (内訳は request-body-limit.ts 冒頭の「メモリの目安」)。

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

// メール取り込みの読み取り全体に許容する最大時間 (4 分)。
//
// **この経路だけ既定値を上書きする理由**: request-body-limit.ts の既定 120 秒は「上限 1MB の
// 経路なら細い回線でもほぼ全域を送り切れる」という前提で決めた値で、上限が 25 倍あるこの経路に
// そのまま当てると、正規の大容量メールが送信途中で打ち切られて 400 になる (プロバイダは再送するが
// 同じ壁に当たるので、最終的にそのメールは取り込まれず失われる)。移行前の arrayBuffer() には
// 時間制限が無かったため、既定のまま使うと移行によるデグレになる。
//
// 一方で「無制限」にはしない (だらだら送りでハンドラを保持され続けるため)。Node の既定
// requestTimeout が 300 秒で、それを超える値を設定してもサーバー側で先に切られて無意味なので、
// その内側に収まる 4 分を上限とする。
export const INBOUND_EMAIL_BODY_TOTAL_TIMEOUT_MS = 240_000;

// Stripe Webhook (`POST /api/webhooks/stripe`) の上限 (1MB)。
// Stripe のイベント JSON は通常数十 KB で、明細行の多い invoice でも 1MB に届くことはまず無い
// (Stripe はコレクションを 10 件程度で切って has_more を返す)。一方で絞りすぎると正規イベントを
// 413 で弾き続け、Stripe が再送を諦めた時点でプラン状態が実際の課金とずれる (最悪、解約済みの
// テナントが Pro 機能を使い続ける) ため、SSO ACS と同じ 1MB の余裕を持たせる。
export const STRIPE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
