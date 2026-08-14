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
//
// **運用上の前提 — この枠は経路ごとに絞れない (要リバースプロキシ)。**
// `proxyClientMaxBodySize` はアプリ全体に 1 つしか持てないため、ここを最大経路 (51MB) に
// 合わせると、上限が桁違いに小さい未認証経路 (LINE Webhook 256KB / マジックリンクの
// コールバック 64KB) にも同じ枠が適用される。しかも入口の複製は**ルート側のゲートより先**に
// 走るので、レート制限も署名検証も間に合わない (下の「タイムアウトが効かない」も参照)。
// 既定の 10MB と比べると未認証経路 1 本あたりの滞留メモリは約 5 倍になる。
// 経路ごとに絞りたい場合は**アプリの手前のリバースプロキシ**で掛けること
// (nginx なら `location` ごとの `client_max_body_size`。本番デプロイの要件として
// `docs/security.md` §7 に設定例つきで記載してある)。これは
// `request-body-limit.ts` 冒頭が「塞ぐならアプリの外側」と書いている既知のギャップと同じ話で、
// 本設定はそれを解消しない — 解消するのは「ルートが受け付けると宣言した本文が
// 実際に届くこと」だけである。
//
// **検討して採らなかった代替案 — proxy の matcher から大きい経路を外す。**
// 複製は proxy が動く経路でしか走らないので、10MB を超える 2 経路 (`/api/inbound/email` /
// `/api/tickets`) を `src/proxy.ts` の matcher から除外すれば複製自体が起きず、枠は既定の
// 10MB のままでよくなる。採らなかった理由は 3 つ:
//   1. **未認証経路の滞留は減らない。** 上の懸念は `/api/inbound/line` や `/api/auth/*`、
//      公開ページの Server Action に対するもので、それらは除外できない (認証ガードが要る)。
//      減るのは「認証済みの大きい 2 経路」の分だけで、狙った所に効かない。
//   2. **リバースプロキシの必要性も消えない。** `/api/auth/[...nextauth]` に上限を掛けられない
//      ギャップは残るため、結局アプリの前段は要る。
//   3. **認証ガードを一切通らない経路を広げる。** matcher の除外はルート単位ではなく
//      プレフィックス単位なので、将来 `/api/tickets/...` に足したルートが黙ってガード対象外に
//      なる。これは `src/proxy.ts` の `INTERNAL_CRON_ROUTES` が「プレフィックス除外をやめて
//      個別列挙にした」判断と正面から衝突する。
// メモリ削減だけを目的に入口の認証境界を動かすのは割に合わないと判断した。やるなら
// 「除外しても安全か」を経路ごとに検証する独立した変更として扱うこと。
//
// **入口の複製にはこのモジュールのタイムアウトが効かない。** Next.js は proxy を実行した
// あとの `finally` で `clonableBody.finalize()` を待ち、これが元リクエストの 'end' を待つ。
// つまり**クライアントが送り終わるまでルートハンドラは起動しない**。`request-body-limit.ts` の
// 無通信 (10 秒) / 全体 (120 秒) の期限は、ルートが読み始めてから初めて効くので、
// 入口で滞留している間は掛からない。ここを縛るのは本設定の枠と、Node の
// サーバー既定 `requestTimeout` (300 秒) だけである。

// **以下の import だけ `@/` エイリアスではなく相対パスで書く (このファイルの特例)。**
// `next.config.ts` が本モジュールを import するため。Next.js は next.config.ts を独自に
// transpile して `require` するが、そのとき tsconfig の `paths` を書き換えるのは
// **next.config.ts 自身の import だけ**で、しかも書き換え先が baseUrl 基準の `./src/lib/x` に
// なる。そこから先のモジュールが `@/...` を持っていると、書き換えられないまま Node の
// 解決に回って `Cannot find module` でビルドが落ちる (相対パスならそのまま解決される)。
// **連鎖はできるだけ「定数だけのファイル」に留める。** 実行時コードを持つモジュールを
// 引き込むと、そちらにまで「相対 import のままにすること」という制約が伝播してしまう
// (元は `magic-link.ts` / `sso-rate-limit.ts` / `html-escape.ts` がそうなっていたので、
// 認証系 2 経路の上限を `auth-body-limits.ts` へ切り出して連鎖から外した)。
// 現在の連鎖は `webhook-body-limits.ts` / `auth-body-limits.ts` / `ticket-body-limits.ts` →
// `domain/attachment` の 4 ファイル。**このうち `domain/attachment` だけは例外で、
// 添付の検証関数も持つ実行時モジュール**である (上限がドメイン定数から導出されるため
// 切り離せない)。あちらにも「config の読み込みグラフに入っている」旨を注記してある。
// **経路上限の import をここへ足すときは、その先の連鎖まで相対パスに揃えること。**
// 揃えないと `npm run build` が落ちる (typecheck とユニットテストは通るので気付きにくい)。
// この不変条件は `tests/entry-body-limit.test.ts` が Next.js 自身の transpile 手順で
// config を読み込んで機械的に確認する。
//
// 受信 Webhook 3 経路 (LINE / メール取り込み / Stripe) の上限
import {
  INBOUND_EMAIL_MAX_BODY_BYTES,
  LINE_WEBHOOK_MAX_BODY_BYTES,
  STRIPE_WEBHOOK_MAX_BODY_BYTES,
} from './webhook-body-limits';
// 認証済みのチケット書き込み 2 経路 (添付付き multipart / 添付なし JSON) の上限
import { ATTACHMENT_UPLOAD_MAX_BODY_BYTES, TICKET_JSON_MAX_BODY_BYTES } from './ticket-body-limits';
// 未認証で到達できる認証系 2 経路 (SSO ACS / マジックリンクのコールバック) の上限
import { MAGIC_LINK_CALLBACK_MAX_BODY_BYTES, SSO_ACS_MAX_BODY_BYTES } from './auth-body-limits';

/**
 * 経路ごとに決めてあるボディ上限の一覧。
 *
 * **入口の上限を導出するためだけの集約で、ここを経路の「正本」にしない。** 各経路の値は
 * それぞれの置き場 (`webhook-body-limits.ts` / `ticket-body-limits.ts` /
 * `auth-body-limits.ts`) が持ち、ここは参照するだけ。
 *
 * **登録漏れはテストが機械的に落とす。** `tests/entry-body-limit.test.ts` が `src/` 配下から
 * `export const *_MAX_BODY_BYTES` を全部拾い、この配列に載っていないものがあれば失敗する。
 * 登録を人手の約束にしておくと、新しい経路の上限がここの最大値を超えたときに
 * 「入口だけが古い枠のまま」= 本ファイル冒頭に書いた静かな切り詰めがそのまま再発するため
 * (命名規約 `*_MAX_BODY_BYTES` に乗せることが、その検出の前提になる点に注意)。
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
 * 経路の上限を「1 チャンクぶん踏み越えた」ことをルート側が観測できるようにするための余白。
 *
 * **入口の枠を経路の最大値ちょうどにすると、ルート側の 413 が到達不能になる。**
 * `readBodyWithinByteLimit` の超過判定は「累計 + 次のチャンク > 上限」なので、上限を
 * **超えるバイトが 1 つでも届く**ことが前提になっている。ところが入口の複製は枠を跨ぐチャンクを
 * まるごと捨てて閉じるため、枠が経路の上限と同じだとルートには常に「上限ちょうど以下」しか
 * 届かず判定が成立しない。結果、Content-Length を省いた chunked 転送で 60MB を送ると、
 * 入口で 51MB に切り詰められ → 判定を素通り → multipart の解析に失敗 → 413 ではなく
 * 400 ('unparsable') が返る。**この経路のために書かれた chunked 対策そのものが無効化される。**
 *
 * 余白を 1MB にしているのは、Node のソケット読み取りが highWaterMark
 * (`ENTRY_OVER_LIMIT_MARGIN_MIN_BYTES` = 64KB) 単位で、捨てられる「枠を跨ぐチャンク」が必ず
 * この中に収まるため (64KB でも足りるが、将来 highWaterMark が変わっても効くよう桁で余裕を取る)。
 * 経路の上限 51MB に対して約 2% で、メモリの見積もりを実質的に動かさない。
 */
const ENTRY_OVER_LIMIT_MARGIN_BYTES = 1024 * 1024;

/**
 * 上の余白が最低限満たすべき大きさ (= Node のソケット読み取り 1 回ぶん / highWaterMark 64KB)。
 *
 * **テストが「余白が消えていないこと」を機械的に固定するために公開する。** 余白を 0 にすると
 * 「入口の枠 ≧ 各経路の枠」は成立したままなので、経路ごとの比較だけでは退行を捕まえられない
 * (上の docstring が説明している 413 到達不能のバグに静かに戻る)。捨てられるチャンクが
 * 必ず収まる大きさ、つまりソケット読み取り 1 回ぶんを下限として明示しておく。
 */
export const ENTRY_OVER_LIMIT_MARGIN_MIN_BYTES = 64 * 1024;

/**
 * 入口でボディを複製・バッファするときの上限バイト数
 * (= 経路別上限の最大値 ＋ 超過をルート側に見せるための余白)。
 *
 * `next.config.ts` の `experimental.proxyClientMaxBodySize` が取るべき値。ここが経路の上限より
 * 小さいと、その経路は「ルートが受け付けるつもりのサイズ」を入口で切り詰められる。
 *
 * `next.config.ts` はこの定数を**そのまま import する**ので、値の書き写しは無い
 * (そのために本モジュールと連鎖するモジュールだけ相対パス import にしてある。上の注記を参照)。
 */
export const ENTRY_MAX_BODY_BYTES =
  Math.max(...ROUTE_MAX_BODY_BYTES) + ENTRY_OVER_LIMIT_MARGIN_BYTES;

/**
 * Next.js が `proxyClientMaxBodySize` 未設定のときに使う既定値 (10MB)。
 *
 * 出典は `next/dist/server/body-streams.js` の `DEFAULT_BODY_CLONE_SIZE_LIMIT`。
 * **テストが「設定しないと壊れる」ことを示すためだけに持つ値**で、実行時には使わない
 * (アプリの挙動をこの値に依存させない)。Next.js 側が既定を変えたらテストが示す前提が
 * 変わるだけで、上の `ENTRY_MAX_BODY_BYTES` の正しさには影響しない。
 */
export const NEXT_DEFAULT_ENTRY_MAX_BODY_BYTES = 10 * 1024 * 1024;
