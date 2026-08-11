// 認証済みのチケット書き込み 2 経路 (新規起票 / コメント投稿) が、リクエストボディを
// 読めなかったときにクライアントへ返す文言。**拒否理由ごとに 1 つずつ**決める。
//
// なぜ route ファイルではなくここに置くのか (`webhook-body-reject-messages.ts` と同じ理由):
// Next.js の Route Handler は既知のエクスポート名しか許さないため route.ts から定数を
// export できず、置いたままではテストから参照できない。ここへ出しておけば、
// `timeout` / `unreadable` のように発火させるのが重い理由まで含めて、**本番の表そのもの**を
// ルート越しではなく直接表明できる (実際の表明は `tests/ticket-body-reject-messages.test.ts`)。
//
// Webhook 3 経路の表 (`webhook-body-reject-messages.ts`) と分けているのは読み手が違うため:
// あちらは LINE / メールプロバイダ / Stripe の配信ログを見る運用者向けで、こちらは
// 画面にそのまま出る利用者向けの文言になる (TicketForm / CommentForm がレスポンスの
// `error` をフォーム下のエラー表示へそのまま流す)。

import type { BodyRejectMessages, BodyReadRejectReason } from '@/lib/request-body-limit';

// 添付付きアップロード (multipart) 2 経路の文言。
// **`unparsable` は移行前の文言をそのまま使う**: この経路は以前から解析失敗時に
// 「リクエストの形式が正しくありません」を返していて、上限つき読み取りへ移しても
// 利用者に見える文言を変える理由が無い (変えると既存の E2E・利用者の問い合わせ文言がずれる)。
//
// 残りの 3 つは利用者が次に取る行動が変わるので分ける: `too-large` は「添付を減らす/小さくする」、
// `timeout` と `unreadable` は「回線の問題なのでもう一度送る」。ここを 1 つの汎用文言に
// まとめると、電波の悪い現場から送った利用者に「入力が不正」と読める案内が出てしまう
// (§1.2 ペルソナ「現場リーダー」はモバイル回線からの添付送信が主な使い方)。
export const TICKET_MULTIPART_BODY_REJECT_MESSAGES: BodyRejectMessages = {
  'too-large': '送信内容が大きすぎます。添付ファイルを減らすか小さくしてお試しください',
  timeout: '送信が途中で止まりました。通信状態をご確認のうえもう一度お試しください',
  unreadable: '送信を最後まで受け取れませんでした。もう一度お試しください',
  unparsable: 'リクエストの形式が正しくありません',
};

// 添付なしの新規起票 (JSON 経路) の文言。
// 本文を読むだけでフォーム解析をしないため `unparsable` は構造上起こらない
// (JSON 自体の解析失敗はこの表ではなく、ルート側の JSON.parse の catch が返す)。
// `too-large` の文言で添付に触れないのは、この経路に添付が無いため
// (「添付を減らして」と案内しても利用者には減らす対象が無い)。
export const TICKET_JSON_BODY_REJECT_MESSAGES: BodyRejectMessages<BodyReadRejectReason> = {
  'too-large': '入力内容が大きすぎます。本文を短くしてお試しください',
  timeout: '送信が途中で止まりました。通信状態をご確認のうえもう一度お試しください',
  unreadable: '送信を最後まで受け取れませんでした。もう一度お試しください',
};
