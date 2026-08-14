// リクエスト入口 (`src/proxy.ts`) で Next.js がボディを複製・バッファするときの上限。
//
// **なぜ必要か — 設定しないと本文が黙って切り詰められる。**
// Next.js は proxy (旧 middleware) を持つアプリでは、非 GET/HEAD のリクエストボディを
// 「proxy 側」と「ルートハンドラ側」の 2 回読めるようにするため、入口で複製してメモリに
// バッファする (`next/dist/server/next-server.js` の `runMiddleware` が
// `clonableBody.cloneBodyStream()` を無条件に呼ぶ。**proxy 自身が本文を読むかどうかに関係なく
// 走る** ので、本リポジトリのように本文へ触れない認証ガードでも対象になる)。
//
// この複製には上限があり、`experimental.proxyClientMaxBodySize` を設定しないと **10MB** が既定に
// なる (`next/dist/server/body-streams.js` の `DEFAULT_BODY_CLONE_SIZE_LIMIT`)。そして上限を
// 超えたときの挙動が問題で、**エラーを返さない**: 警告を 1 行 console に出したうえで、
// 複製ストリームを先頭 10MB で `push(null)` して閉じ、リクエストはそのまま処理へ進む。
// つまりルートハンドラは「10MB で途中から欠けた本文」を、完全な本文として受け取る。
//
// 本リポジトリには 10MB を超える上限を持つ経路が 2 系統あり、既定のままだと実害が出る:
//   - `POST /api/inbound/email` (25MB) … 10MB を超えるメールは multipart が途中で切れ、
//     `readFormWithinByteLimit` が 'unparsable' → 400。送信プロバイダは再送するが同じ壁に
//     当たるため、再送が尽きた時点で**そのメールは取り込まれず失われる**。
//   - `POST /api/tickets` / `POST /api/tickets/[id]/comments` (51MB) … 添付付きアップロードが
//     同様に壊れ、`MAX_ATTACHMENT_SIZE_BYTES` (10MB) の添付 1 件でも multipart の境界行と
//     ヘッダ行の分だけ 10MB を超えるため、**上限いっぱいの添付は 1 件でも通らない**。
//   実測 (`getCloneableBody` を next-server と同じ順序で呼んだ場合): 12MB の本文を流すと
//   ルート側の受領は 10.00MB、25MB でも 10.00MB。下の値を設定すると 51MB でも全量届く。
//
// **値は経路別の上限の最大値から導出する。** 直書きにすると、どこかの経路の上限を引き上げた
// ときに入口だけが古い値のまま残り、「ルートは受け付けるつもりなのに入口で切り詰められる」
// という上と同じ壊れ方が静かに戻る。max を取っておけば、経路側を上げれば入口も自動で追随する
// (`tests/entry-body-limit.test.ts` が全経路の上限を下回らないことを機械的に固定する)。
//
// **メモリの見積もり**: この複製は「ルートが読む本文」とは別に積み上がる。proxy へ渡される側
// (`p1`) は本リポジトリの認証ガードが読まないため本文サイズぶんがそのまま滞留し、ルートが読む側
// (`p2`) も読み出しが追いつかない分を保持する。したがって入口だけで本文サイズの 1〜2 倍を
// 見込む必要があり、これは `request-body-limit.ts` 冒頭の「メモリの目安」(読み取り・解析側で
// 約 3 倍) に**上乗せ**される。上限を引き上げるときは両方を足して考えること。
// なお、この複製自体を止める設定は Next.js 側に無い (proxy を置く限り必ず走る)。

// 受信 Webhook 3 経路 (LINE / メール取り込み / Stripe) の上限
import {
  INBOUND_EMAIL_MAX_BODY_BYTES,
  LINE_WEBHOOK_MAX_BODY_BYTES,
  STRIPE_WEBHOOK_MAX_BODY_BYTES,
} from '@/lib/webhook-body-limits';
// 認証済みのチケット書き込み 2 経路 (添付付き multipart / 添付なし JSON) の上限
import {
  ATTACHMENT_UPLOAD_MAX_BODY_BYTES,
  TICKET_JSON_MAX_BODY_BYTES,
} from '@/lib/ticket-body-limits';
// SSO ACS (SAML アサーション POST) の上限
import { SSO_ACS_MAX_BODY_BYTES } from '@/lib/sso-rate-limit';
// マジックリンクのコールバック (POST) の上限
import { MAGIC_LINK_CALLBACK_MAX_BODY_BYTES } from '@/lib/magic-link';

/**
 * 経路ごとに決めてあるボディ上限の一覧。
 *
 * **入口の上限を導出するためだけの集約で、ここを経路の「正本」にしない。** 各経路の値は
 * それぞれの置き場 (`webhook-body-limits.ts` / `ticket-body-limits.ts` / `sso-rate-limit.ts` /
 * `magic-link.ts`) が持ち、ここは参照するだけ。テストが「この一覧に載っていない経路上限が
 * 増えていないか」までは見られないので、**経路を足したらこの配列にも足すこと**
 * (足し忘れても入口が経路より小さくなるのは、新しい経路の上限がここの最大値を超えたときだけ)。
 */
const ROUTE_MAX_BODY_BYTES = [
  LINE_WEBHOOK_MAX_BODY_BYTES, // LINE Webhook (256KB)
  INBOUND_EMAIL_MAX_BODY_BYTES, // メール取り込み (25MB)
  STRIPE_WEBHOOK_MAX_BODY_BYTES, // Stripe Webhook (1MB)
  ATTACHMENT_UPLOAD_MAX_BODY_BYTES, // 添付付きチケット起票・コメント投稿 (51MB)
  TICKET_JSON_MAX_BODY_BYTES, // 添付なしチケット起票 (128KB)
  SSO_ACS_MAX_BODY_BYTES, // SSO ACS (1MB)
  MAGIC_LINK_CALLBACK_MAX_BODY_BYTES, // マジックリンクのコールバック (64KB)
] as const;

/**
 * 入口でボディを複製・バッファするときの上限バイト数 (= 経路別上限の最大値)。
 *
 * `next.config.ts` の `experimental.proxyClientMaxBodySize` が取るべき値。ここが経路の上限より
 * 小さいと、その経路は「ルートが受け付けるつもりのサイズ」を入口で切り詰められる。
 *
 * **next.config.ts はこの定数を import できない。** Next.js は next.config.ts を独自に
 * transpile して `require` するが、tsconfig の `paths` を書き換えるのは next.config.ts 自身の
 * import だけで、そこから先のモジュールが持つ `@/...` は解決されない (実測: 本モジュールを
 * import させると `Cannot find module './src/lib/webhook-body-limits'` でビルドが落ちる)。
 * そのため向こうには同じ値を数値で書き、一致は `tests/entry-body-limit.test.ts` が固定する
 * — 導出の根拠 (どの経路の上限を数えているか) はこちらに 1 つだけ置いたままにできる。
 */
export const ENTRY_MAX_BODY_BYTES = Math.max(...ROUTE_MAX_BODY_BYTES);

/**
 * Next.js が `proxyClientMaxBodySize` 未設定のときに使う既定値 (10MB)。
 *
 * 出典は `next/dist/server/body-streams.js` の `DEFAULT_BODY_CLONE_SIZE_LIMIT`。
 * **テストが「設定しないと壊れる」ことを示すためだけに持つ値**で、実行時には使わない
 * (アプリの挙動をこの値に依存させない)。Next.js 側が既定を変えたらテストが示す前提が
 * 変わるだけで、上の `ENTRY_MAX_BODY_BYTES` の正しさには影響しない。
 */
export const NEXT_DEFAULT_ENTRY_MAX_BODY_BYTES = 10 * 1024 * 1024;
