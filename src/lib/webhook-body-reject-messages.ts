// 受信 Webhook 3 経路 (LINE 取り込み / メール取り込み / Stripe 課金) が、リクエストボディを
// 読めなかったときにクライアントへ返す文言。**拒否理由ごとに 1 つずつ**決める。
//
// なぜ route ファイルではなくここに置くのか (`webhook-body-limits.ts` と同じ理由):
// Next.js の Route Handler は既知のエクスポート名しか許さないため route.ts から定数を
// export できず、置いたままではテストから参照できない。そしてこの表は
// **テストから参照できないと守れない**性質を持つ:
//   - 「理由ごとに文言を引く」実装 (`bodyRejectResponse`) をステータスの 2 値で選ぶ形に
//     戻す退行は、`too-large` と `unparsable` だけを見ても検出できない (どちらの実装でも
//     同じ文字列になるため)。**検出できるのは `timeout` の文言だけ**で、その理由を
//     ルート越しに発火させるには実時間で無通信タイムアウトを待つ必要がありテストが重い。
//   - 表をここへ出しておけば、ルートを経由せずに表そのもの＋ヘルパーの組で表明できる。
// 実際の表明は `tests/webhook-body-reject-messages.test.ts`。

import type { BodyRejectMessages } from '@/lib/body-reject-response';
import type { BodyReadRejectReason } from '@/lib/request-body-limit';

// LINE Webhook (`POST /api/inbound/line`) の文言。
// LINE は非 2xx を受けると再送するため、こちら側の都合 (上限超過) と送信側の都合
// (本文が届き切らなかった) を文言で区別できるようにしておく。
// 'timeout' (送信が止まった) と 'unreadable' (接続断などで読み取り自体が失敗した) は
// どちらも**本文が届き切らなかった**側なので、そう読める文言にする — 「形式が正しくない」と
// 返すと、回線が切れただけの配信をプロバイダ側がペイロードの不具合として調査してしまう。
// この経路は本文を読むだけでフォーム解析をしないので 'unparsable' は構造上起こらない
export const LINE_BODY_REJECT_MESSAGES: BodyRejectMessages<BodyReadRejectReason> = {
  'too-large': 'リクエストが大きすぎます',
  timeout: 'リクエストの送信が途中で止まりました',
  unreadable: 'リクエストを最後まで受け取れませんでした',
};

// メール取り込み (`POST /api/inbound/email`) の文言。
// この経路だけ multipart を読むため 'unparsable' が実際に起こりうる。
// 調査先が変わるので 3 つを分ける: 'timeout' は送信が途中で止まった、'unreadable' は
// 接続断などで最後まで受け取れなかった (どちらも回線側)、'unparsable' は届いた本文を
// フォームとして解釈できなかった (本文の組み立て側)
export const INBOUND_EMAIL_BODY_REJECT_MESSAGES: BodyRejectMessages = {
  'too-large': 'メールが大きすぎます',
  timeout: 'メールの送信が途中で止まりました',
  unreadable: 'メールを最後まで受け取れませんでした',
  unparsable: 'リクエストの形式が正しくありません',
};

// Stripe Webhook (`POST /api/webhooks/stripe`) の文言。
// Stripe はどの非 2xx でも再送するが、正規イベントがこの経路で失われるのは異常系なので
// 「受け取れなかった」ことを 2xx で覆い隠さない (§9 fail-closed)。文言を理由ごとに分けるのは、
// Stripe の配信ログを見た運用者がサイズ超過と接続断を取り違えないようにするため
export const STRIPE_BODY_REJECT_MESSAGES: BodyRejectMessages<BodyReadRejectReason> = {
  'too-large': 'リクエストボディが大きすぎます',
  timeout: 'リクエストボディの送信が途中で止まりました',
  unreadable: 'リクエストボディの読み取りに失敗しました',
};
