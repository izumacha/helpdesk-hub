// Route Handler が返したエラー応答から、画面に出す日本語メッセージを取り出す共通ヘルパー。
//
// なぜ 1 箇所に集約するか: 新規起票 (TicketForm) とコメント投稿 (CommentForm) が
// **同じ 8 行を書き写していた** — API のエラー契約 `{ error, issues }` の形を型で書き下し、
// `issues[0].message` を優先し、JSON として読めなければステータスを添えた文言へ落とす、という
// 手順が完全に同じだった。契約側に項目が増えたときに 2 ファイルを探して直す必要があり、
// 片方を直し忘れると 2 つのフォームで案内がずれる (§6 DRY: 2 箇所目で共通化する)。
//
// **応答の本文を読むのはここだけにする。** 呼び出し元が `res.json()` を自前で呼ぶと、
// 解析失敗を捕まえ忘れる余地が残る (捕まえ損ねると例外がそのまま浮いて画面に何も出ない)。

// API のエラー応答の形。`issues` は Zod 互換 (422 の添付検証などが使う)
interface ApiErrorBody {
  error?: string; // 汎用のエラー文言
  issues?: Array<{ message?: string }>; // 項目ごとの検証エラー (先頭を採用する)
}

/**
 * エラー応答 (res.ok === false) から利用者向けのメッセージを組み立てる。
 *
 * 優先順位は `issues[0].message` → `error` → 呼び出し元が渡した既定文言。
 * `issues` を先に見るのは、添付検証の 422 のように「どう直せばよいか」が
 * 具体的に書かれているのがそちらだからである。
 *
 * 本文が JSON として読めない場合 (プロキシが返す 413 の HTML、502 の素のテキスト等) は、
 * 理由をコンソールに残したうえでステータス番号を添えた文言へ落とす
 * (§6 エラーを握り潰さない / §9 内部詳細は画面に出さない)。
 *
 * **引数はオブジェクトで受け取る。** `fallbackMessage` と `logPrefix` はどちらも string なので、
 * 位置引数だと取り違えても型検査を通ってしまい、画面に '[TicketForm] (HTTP 502)' が出て
 * ログ側に利用者向け文言が流れる、という壊れ方をする (このヘルパーは「間違えようがない形」に
 * するために切り出したので、その穴を残さない)。
 *
 * @param res 失敗した fetch のレスポンス
 * @param options.fallbackMessage 本文から何も読み取れなかったときに使う既定文言
 * @param options.logPrefix ログ行の先頭に付ける識別子 (角括弧まで含めて渡す。例: '[TicketForm]')
 * @returns 画面にそのまま出せる日本語メッセージ
 */
export async function readApiErrorMessage(
  res: Response,
  options: {
    fallbackMessage: string; // 何も読み取れなかったときに出す文言
    logPrefix: string; // ログ行の識別子 (角括弧込み)
  },
): Promise<string> {
  const { fallbackMessage, logPrefix } = options;
  try {
    // エラー契約の形を明示して読む (any にしない / §6 TypeScript)
    const body = (await res.json()) as ApiErrorBody | null;
    // 項目ごとの検証エラーがあれば、その先頭を最優先で使う
    const issueMessage = Array.isArray(body?.issues) ? body.issues[0]?.message : null;
    // **文字列であることを実際に確かめてから返す。** 上のキャストは型注釈にすぎず、
    // 想定外の応答 ({"error": {"code": "..."}} 等) では object が素通りしてしまう。
    // それを setState に渡すと React が「Objects are not valid as a React child」で
    // 描画ごと落ち、エラー表示どころか画面が真っ白になる
    if (typeof issueMessage === 'string') return issueMessage;
    if (typeof body?.error === 'string') return body.error;
    // 読めたが文字列ではなかった場合も、既定文言へ落とす
    return fallbackMessage;
  } catch (parseErr) {
    // JSON として読めなかった理由はコンソールに残す (画面には出さない)
    console.error(`${logPrefix} エラー応答を JSON として解析できませんでした`, parseErr);
    // 利用者には既定文言 + ステータス番号だけを伝える (問い合わせ時の手掛かりになる)
    return `${fallbackMessage} (HTTP ${res.status})`;
  }
}
