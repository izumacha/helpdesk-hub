// リクエストボディをバイト数上限つきで読み取る共通ヘルパー。
//
// 未認証で到達できる POST エンドポイントは、ボディ全体をメモリに載せる前に必ずサイズを
// 検査する必要がある (§9「リクエストサイズ・タイムアウト…を設けて DoS とリソース枯渇を防ぐ」)。
//
// **Content-Length ヘッダの検査だけでは足りない。** chunked 転送 (Transfer-Encoding: chunked)
// では Content-Length を省略でき、その場合 `req.arrayBuffer()` / `req.text()` / `req.formData()`
// は上限に関係なくボディ全体をメモリに展開してしまう (実測: Content-Length 無しの 50MB ボディで
// arrayBuffer() は 52,428,800 バイトをそのまま返す)。「読み込んでからバイト数を測る」実装は
// 測った時点で既に手遅れで、ヘッダを省略するだけで回避できる。
//
// そのためここではボディを**ストリームとして少しずつ読み**、累計が上限を超えた時点で
// 読み取りを打ち切る (実測: 500MB 流せるストリームでも上限 1MB なら 1,114,112 バイトで停止する)。
//
// メモリの目安: 上限超過を検知するまでに保持するのは「上限 + チャンク 1 個分」だが、
// **上限内で読み切った場合の実際のピークはおよそ上限の 2〜3 倍**になる。チャンク配列と、
// それを連結した ArrayBuffer が同時に存在し、さらに呼び出し元が formData() でパースすると
// フィールド値のコピーがもう 1 つできるため。上限値を決めるときはこの倍率を見込むこと。

// バイト列としての読み取り結果。
// bytes を ArrayBuffer で返すのは、そのまま Response/Request の body に渡せる型 (BodyInit) だから
export type BoundedBodyResult =
  | { ok: true; bytes: ArrayBuffer } // 上限内で読み切れた
  | { ok: false; reason: 'too-large' } // 上限超過 (ヘッダ申告 or ストリームの累計)
  | { ok: false; reason: 'unreadable' }; // ストリームの読み取り自体に失敗した (接続断など)

// フォームとしての読み取り結果 (バイト列の結果に「パースできなかった」を足したもの)
export type BoundedFormResult =
  | { ok: true; form: FormData } // 上限内で読み取れてフォームとしてパースできた
  | { ok: false; reason: 'too-large' | 'unreadable' | 'unparsable' };

/**
 * リクエストボディを最大 `maxBytes` バイトまで読み取る。
 *
 * 二段構え:
 *   1. Content-Length の申告が上限超過なら、本文を一切読み進めずに打ち切る。
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
  // 上限超過を検知したかどうか (検知したら読み取りをやめる)
  let exceeded = false;

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
        exceeded = true;
        break;
      }
      // 上限内なので保持する
      chunks.push(value);
    }
  } catch {
    // 途中で切れた接続・壊れたストリームなど。呼び出し元が拒否理由を出し分けられるよう返す
    // (例外を投げ直さないのは、呼び出し元が「拒否」以外の選択肢を持たないため。ログは呼び出し元が出す)
    return { ok: false, reason: 'unreadable' };
  } finally {
    // 残りのストリームを破棄する (読み続けてメモリを積まない)。
    // cancel() は「既にエラー状態のストリーム」に対しては reject するため、必ず握って捨てる:
    // ここで reject を伝播させると、上限超過で打ち切った判定が unreadable に化けてしまい、
    // サイズ攻撃のログが接続断のログとして記録される (両者は応答も監査行も同じなので、
    // ログだけが唯一の見分けどころ)
    void reader.cancel().catch(() => {});
  }

  // 上限超過なら、ここまでに溜めたチャンクは捨てて拒否を返す
  if (exceeded) return { ok: false, reason: 'too-large' };

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

/**
 * リクエストボディをバイト数上限つきで読み取り、そのまま FormData としてパースする。
 *
 * `req.formData()` を直接呼ぶとボディ全体がメモリに展開されてしまうため、
 * 上限つきで読んだバイト列を改めてパースし直す形にしている。Content-Type は元の
 * リクエストから引き継ぐ (multipart の boundary パラメータを失わないため)。
 *
 * @param req 読み取り対象のリクエスト
 * @param maxBytes 許容する最大バイト数
 */
export async function readFormWithinByteLimit(
  req: Request,
  maxBytes: number,
): Promise<BoundedFormResult> {
  // まずバイト列として上限つきで読む (超過・読み取り失敗はここで判別される)
  const body = await readBodyWithinByteLimit(req, maxBytes);
  // 読めなかった理由はそのまま呼び出し元へ渡す
  if (!body.ok) return body;

  try {
    // サイズ検査済みのバイト列を、元の Content-Type のままフォームとしてパースし直す
    const form = await new Response(body.bytes, {
      headers: { 'content-type': req.headers.get('content-type') ?? '' },
    }).formData();
    // パースできたフォームを返す
    return { ok: true, form };
  } catch {
    // Content-Type 不一致・本文破損など。ログは呼び出し元が文脈付きで出す
    return { ok: false, reason: 'unparsable' };
  }
}
