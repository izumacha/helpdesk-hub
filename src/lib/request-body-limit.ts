// リクエストボディをバイト数上限つきで読み取る共通ヘルパー。
//
// 未認証で到達できる POST エンドポイントは、ボディ全体をメモリに載せる前に必ずサイズを
// 検査する必要がある (§9「リクエストサイズ・タイムアウト…を設けて DoS とリソース枯渇を防ぐ」)。
//
// **Content-Length ヘッダの検査だけでは足りない。** chunked 転送 (Transfer-Encoding: chunked)
// では Content-Length を省略でき、その場合 `req.arrayBuffer()` / `req.formData()` は
// 上限に関係なくボディ全体をメモリに展開してしまう (実測: Content-Length 無しの 50MB ボディで
// arrayBuffer() は 52,428,800 バイトをそのまま返す)。「読み込んでからバイト数を測る」実装は
// 測った時点で既に手遅れで、ヘッダを省略するだけで回避できる。
//
// そのためここではボディを**ストリームとして少しずつ読み**、累計が上限を超えた時点で
// 読み取りを打ち切る。ピークメモリは「上限 + チャンク 1 個分」に抑えられる。
// bytes を ArrayBuffer で返すのは、そのまま `new Request(..., { body })` に渡せる型
// (BodyInit) だから。Uint8Array のままだと呼び出し側で型変換が要る
export type BoundedBodyResult =
  | { ok: true; bytes: ArrayBuffer } // 上限内で読み切れた
  | { ok: false; reason: 'too-large' } // 上限超過 (ヘッダ申告 or 実バイト数)
  | { ok: false; reason: 'unreadable' }; // ストリームの読み取り自体に失敗した

/**
 * リクエストボディを最大 `maxBytes` バイトまで読み取る。
 *
 * 二段構え:
 *   1. Content-Length の申告が上限超過なら、本文を一切読まずに打ち切る。
 *   2. 申告が無い/過少申告でも、ストリームの累計バイト数が上限を超えた時点で打ち切る。
 *
 * @param req 読み取り対象のリクエスト (ボディは呼び出し後に消費済みになる)
 * @param maxBytes 許容する最大バイト数 (この値ちょうどまでは許可し、超えた分を拒否する)
 */
export async function readBodyWithinByteLimit(
  req: Request,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  // Content-Length の申告値を読む。|| '-1' で null (ヘッダ無し) と空文字列の両方を -1 にまとめる
  // (?? は null/undefined しか補填せず空文字列を拾えないため || を使う)。
  // -1 は上限より小さいのでこの事前検査は通過し、後段のストリーム検査に委ねられる
  const declaredLength = Number(req.headers.get('content-length') || '-1');
  // 数値として読めて上限を超えているなら、本文を読まずにここで打ち切る (一番安い拒否)
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, reason: 'too-large' };
  }

  // ボディが無いリクエスト (GET など) は空のバイト列として扱う
  if (!req.body) return { ok: true, bytes: new ArrayBuffer(0) };

  // ストリームを 1 チャンクずつ読むためのリーダーを取得する
  const reader = req.body.getReader();
  // 読み取ったチャンクを溜める配列 (最後に 1 本のバイト列へ連結する)
  const chunks: Uint8Array[] = [];
  // ここまでに読んだ累計バイト数
  let totalBytes = 0;

  try {
    // ストリームの終端に達するまで読み続ける
    for (;;) {
      // 次のチャンクを 1 つ読む
      const { done, value } = await reader.read();
      // 終端に達したらループを抜ける
      if (done) break;
      // 累計バイト数を進める
      totalBytes += value.byteLength;
      // 上限を超えた時点で、残りを読まずに打ち切る (ここがピークメモリを抑えている要点)
      if (totalBytes > maxBytes) {
        // 残りのストリームを破棄する (読み続けてメモリを積まない)
        await reader.cancel();
        return { ok: false, reason: 'too-large' };
      }
      // 上限内なので保持する
      chunks.push(value);
    }
  } catch {
    // 途中で切れた接続・壊れたストリームなど。呼び出し元が拒否理由を出し分けられるよう返す
    // (例外を投げ直さないのは、呼び出し元が「拒否」以外の選択肢を持たないため。ログは呼び出し元が出す)
    return { ok: false, reason: 'unreadable' };
  }

  // チャンクを 1 本のバイト列へ連結する (合計サイズは上限以下だと確認済み)。
  // ArrayBuffer を明示的に確保してから View を被せる (返り値をそのまま body に渡せる型にするため)
  const buffer = new ArrayBuffer(totalBytes);
  // 書き込み用の View
  const view = new Uint8Array(buffer);
  // 連結時の書き込み位置
  let offset = 0;
  // 各チャンクを順に書き込む
  for (const chunk of chunks) {
    // 現在位置にチャンクを配置する
    view.set(chunk, offset);
    // 次の書き込み位置へ進める
    offset += chunk.byteLength;
  }
  // 上限内で読み切れたバイト列を返す
  return { ok: true, bytes: buffer };
}
