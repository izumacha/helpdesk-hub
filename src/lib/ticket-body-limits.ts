// 認証済みのチケット書き込み 2 経路 (新規起票 / コメント投稿) が受け付ける
// リクエストボディの「受け入れ枠」— 最大バイト数。
//
// なぜ route ファイルではなくここに置くのか (`webhook-body-limits.ts` と同じ理由):
// Next.js の Route Handler は既知のエクスポート名 (GET/POST/runtime 等) しか許さないため、
// route.ts から定数を export できない。route とテストが同じ定義を参照する (= 片方だけ値を
// 変えたら気付ける) ようにするには、両者から import できる場所へ出す必要がある。
// 受信 Webhook 3 経路の上限は `webhook-body-limits.ts` に置いてあるので、この 2 経路は
// 「認証済みのチケット書き込み」というひとまとまりの関心事としてこちらに分ける
// (Webhook の枠に混ぜると、未認証で到達できる経路の一覧として読めなくなる)。
//
// 実際の読み取り (ストリームを上限つきで読み、超えた時点で打ち切る) は
// `request-body-limit.ts` の `readFormWithinByteLimit` / `readTextWithinByteLimit` が担う。
// 上限値をここで決め、読み取り方法をあちらに集約する分担にしている。
//
// **なぜ認証済みの経路にも上限が要るのか**: `req.formData()` / `req.json()` を直接呼ぶと、
// Content-Length を省いた chunked 転送に対しては上限なくボディ全体がメモリへ展開される
// (詳細は `request-body-limit.ts` 冒頭)。ログイン済みしか到達できず 1 分あたりの本数も
// レート制限で絞ってあるぶん未認証経路より優先度は低いが、「1 リクエストで確保できる量が
// 無制限」という性質そのものは同じなので枠を決める (§9 リクエストサイズの上限)。
//
// 値を決めるときの注意: 読み取り中の一時コピーを含めて、本文サイズの約 3 倍のメモリを
// 見込むこと (内訳は request-body-limit.ts 冒頭の「メモリの目安」)。

// 1 回のアップロードで許す添付の件数・1 件あたりのサイズ上限 (ドメイン定数が唯一の源)
import { MAX_ATTACHMENTS_PER_UPLOAD, MAX_ATTACHMENT_SIZE_BYTES } from '@/domain/attachment';

// multipart の「ファイルバイト列以外」に見込む余裕 (1MB)。
// 内訳は (a) テキストフィールド (title / body / priority / categoryId / dueDate / locationId)、
// (b) パートごとのヘッダ行 (Content-Disposition のファイル名を含む) と境界行。
// いずれもファイル本体に比べれば桁が小さいので、細かく足し上げるより余裕のある 1 枠にまとめる
// (ここを詰めても防御力は上がらず、正規のアップロードを 413 で弾く危険だけが増える)。
const MULTIPART_ENVELOPE_OVERHEAD_BYTES = 1024 * 1024;

// 添付付きアップロード (multipart/form-data) の上限。
// **ドメイン定数から導出する**のが要点で、`MAX_ATTACHMENTS_PER_UPLOAD` や
// `MAX_ATTACHMENT_SIZE_BYTES` を将来引き上げたときに、この枠だけが古い値のまま残って
// 正規のアップロードを 413 で弾くのを防ぐ (値を直書きすると二重管理になる)。
//
// この枠は「検証を通りうる最大の本文」より少しだけ大きい: 添付の件数・サイズ超過は
// `validateUploadedFiles` が 422 + 具体的な文言で返すのが本来の経路なので、その手前の
// 上限で潰してしまわない方が利用者に伝わる。ここで弾きたいのは「検証にかける前に
// メモリを食い尽くす量」だけである。
//
// 新規起票 (`POST /api/tickets`) とコメント投稿 (`POST /api/tickets/[id]/comments`) の
// 2 経路で共有する: どちらも同じ添付検証 (`validateUploadedFiles`) を通り、テキスト部分の
// 差 (起票の body 10,000 文字 / コメントの body 5,000 文字) は上の余裕枠に収まるため、
// 経路ごとに別の値を持つ意味がない。
export const ATTACHMENT_UPLOAD_MAX_BODY_BYTES =
  MAX_ATTACHMENTS_PER_UPLOAD * MAX_ATTACHMENT_SIZE_BYTES + MULTIPART_ENVELOPE_OVERHEAD_BYTES;

// 添付付きアップロードの読み取り全体に許容する最大時間 (4 分)。
//
// **この経路が既定値 (`DEFAULT_BODY_TOTAL_TIMEOUT_MS` = 120 秒) を上書きする理由**:
// 既定は「上限 1MB の経路なら細い回線でもほぼ全域を送り切れる」という前提で決めた値で、
// 上限が 50 倍あるこの経路にそのまま当てると、正規のアップロードが送信途中で打ち切られて
// 400 になる。移行前の `req.formData()` には時間制限が無かったため、既定のままでは
// **移行によるデグレ**になる (上限 25MB のメール取り込みが
// `INBOUND_EMAIL_BODY_TOTAL_TIMEOUT_MS` で同じ上書きをしているのと同じ理由)。
//
// 目安: 上り 1Mbps (125KB/s) のモバイル回線なら 4 分で約 30MB — 現場で撮った写真 3 枚
// (1 枚 10MB 上限なので最大 30MB) がちょうど収まる。**枠いっぱいの 51MB を上り 1Mbps で
// 送り切るには 7 分近くかかり、それは Node の既定 requestTimeout (300 秒) の外なので
// この定数をいくら延ばしても届かない** — サーバー側で先に切られる。上限バイト数の枠と
// 送り切れる時間の枠は別物で、後者は Node の 300 秒が天井になる点に注意。
//
// 一方で「無制限」にはしない (だらだら送りでハンドラを保持され続けるため)。
export const ATTACHMENT_UPLOAD_BODY_TOTAL_TIMEOUT_MS = 240_000;

// 添付なしの新規起票 (`application/json` 経路) の上限 (128KB)。
//
// この経路の本文はテキストフィールドだけで、最長の `body` は `createTicketSchema` が
// 10,000 文字に制限している。**文字数の上限は Zod スキーマが唯一の源**なので、その数値を
// ここへ写して掛け算する形にはしない (写した側だけが古くなる)。代わりに「スキーマの上限を
// 最も不利に数えても収まる」余裕のある値を置く: 1 文字を UTF-8 最長の 4 バイトで数えると
// 40KB、クライアントが非 ASCII を `\uXXXX` (1 文字 6 バイト) へすべて置き換えても 60KB で、
// title (200 文字) やフィールド名を足しても 128KB には収まる。
//
// multipart 側と分けているのは、添付が無いと分かっている経路に 51MB の枠を与える理由が
// 無いため (§9 最小権限・最小公開: 経路ごとに必要な分だけ許す)。
export const TICKET_JSON_MAX_BODY_BYTES = 128 * 1024;
