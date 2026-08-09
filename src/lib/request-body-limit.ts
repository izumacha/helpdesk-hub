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
// 読み取りを打ち切る (実測: 500MB 流せるストリームでも上限 1MB なら約 1.1MB で停止する)。
//
// 防いでいる攻撃は 3 つで、それぞれ対策が別:
//   1. 巨大な本文 → 累計バイト数が上限を超えた時点で打ち切る。
//   2. **細切れチャンクによる増幅** → 読み取ったチャンクを配列に溜める実装だと、1 バイトずつ
//      刻んだ chunked 転送で「本文は上限内なのに Uint8Array オブジェクトが本文バイト数だけ
//      積まれる」増幅が起きる (実測: 上限 1MB ちょうどの本文で約 231MB のヒープを確保でき、
//      ワイヤ上はわずか約 6MB で足りる)。そのため**上限ぶんのバッファを最初に確保して
//      そこへ書き込む**形にし、メモリ使用量をチャンク数から独立させる。
//   3. **slowloris (だらだら送り)** → 累計が上限に届かない速度で送り続ければループは終わらず、
//      ハンドラと接続が保持され続ける。読み取り全体に制限時間を設けて打ち切る。
//
// メモリの目安: 1 リクエストあたり「上限ぶんのバッファ」を確保する。読み切った後に実サイズへ
// 詰め直すため一瞬だけ上限の 2 倍になり、さらに呼び出し元が formData() でパースすると
// フィールド値のコピーがもう 1 つできる。上限値を決めるときはこの倍率を見込むこと。

// 読み取り全体の既定の制限時間 (slowloris 対策)。正規のクライアントは上限サイズの本文でも
// 数秒あれば送り切れるため、余裕を見て 10 秒に置く
export const DEFAULT_BODY_READ_TIMEOUT_MS = 10_000;

// 制限時間切れを他の例外と区別するための番人。文字列やエラーメッセージで判定すると
// 偶然一致した別の例外を取り違えるため、このモジュール専用の Symbol を使う
const BODY_READ_TIMEOUT = Symbol('body-read-timeout');

// バイト列としての読み取り結果。
// bytes を ArrayBuffer で返すのは、そのまま Response/Request の body に渡せる型 (BodyInit) だから
export type BoundedBodyResult =
  | { ok: true; bytes: ArrayBuffer } // 上限内で読み切れた
  | { ok: false; reason: 'too-large' } // 上限超過 (ヘッダ申告 or ストリームの累計)
  | { ok: false; reason: 'timeout' } // 制限時間内に読み切れなかった (だらだら送り)
  | { ok: false; reason: 'unreadable' }; // ストリームの読み取り自体に失敗した (接続断など)

// フォームとしての読み取り結果 (バイト列の結果に「パースできなかった」を足したもの)
export type BoundedFormResult =
  | { ok: true; form: FormData } // 上限内で読み取れてフォームとしてパースできた
  | { ok: false; reason: 'too-large' | 'timeout' | 'unreadable' | 'unparsable' };

/**
 * リクエストボディを最大 `maxBytes` バイトまで読み取る。
 *
 * 三段構え:
 *   1. Content-Length の申告が上限超過なら、本文を一切読み進めずに打ち切る。
 *   2. 申告が無い/過少申告でも、ストリームの累計バイト数が上限を超えた時点で打ち切る。
 *   3. 全体が `timeoutMs` を超えたら打ち切る (上限に届かない速度で送り続ける攻撃への対策)。
 *
 * @param req 読み取り対象のリクエスト (ボディは呼び出し後に消費済みになる)
 * @param maxBytes 許容する最大バイト数 (この値ちょうどまでは許可し、超えた分を拒否する)
 * @param timeoutMs 読み取り全体の制限時間 (既定 DEFAULT_BODY_READ_TIMEOUT_MS)
 */
export async function readBodyWithinByteLimit(
  req: Request,
  maxBytes: number,
  timeoutMs: number = DEFAULT_BODY_READ_TIMEOUT_MS,
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

  // 上限ぶんのバッファを先に確保し、チャンクをここへ書き込んでいく。
  // チャンクを配列に溜めないので、1 バイト刻みで送られてもメモリは上限で頭打ちになる
  const buffer = new ArrayBuffer(maxBytes);
  // 書き込み用の View
  const view = new Uint8Array(buffer);
  // ここまでに書き込んだ累計バイト数
  let totalBytes = 0;
  // 上限超過を検知したか (検知したら読み取りをやめる)
  let exceeded = false;
  // ストリームのリーダー (finally で確実に cancel するため try の外で宣言する)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  // 制限時間切れを知らせるタイマー (finally で必ず解除する)
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  // 制限時間を超えたら reject する Promise を 1 つだけ作る。
  // ループの中で作ると読み取り回数ぶんタイマー/リスナーが積み上がる
  const timedOut = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(BODY_READ_TIMEOUT), timeoutMs);
  });
  // race で拾われなかった場合に unhandledRejection にならないよう、先に handled 扱いにする
  // (ここで catch を足しても race 側は変わらず reject を受け取れる)
  void timedOut.catch(() => {});

  try {
    // ストリームを 1 チャンクずつ読むためのリーダーを取得する
    // (ボディが他所でロック済みなら例外になるため、try の中で呼ぶ)
    reader = req.body.getReader();
    // ストリームの終端に達するまで読み続ける
    for (;;) {
      // 次のチャンクを 1 つ読む。制限時間を超えたら timedOut 側が先に reject する
      const { done, value } = await Promise.race([reader.read(), timedOut]);
      // 終端に達したらループを抜ける
      if (done) break;
      // 上限を超えるなら、書き込まずに打ち切る (ここがメモリを抑えている要点)
      if (totalBytes + value.byteLength > maxBytes) {
        exceeded = true;
        break;
      }
      // 確保済みバッファの続きへ書き込む
      view.set(value, totalBytes);
      // 累計バイト数を進める
      totalBytes += value.byteLength;
    }
  } catch (err) {
    // 制限時間切れ (だらだら送り) と、それ以外の読み取り失敗を区別して返す
    if (err === BODY_READ_TIMEOUT) return { ok: false, reason: 'timeout' };
    // 途中で切れた接続・壊れたストリームなど。呼び出し元が拒否理由を出し分けられるよう返す
    // (例外を投げ直さないのは、呼び出し元が「拒否」以外の選択肢を持たないため。ログは呼び出し元が出す)
    return { ok: false, reason: 'unreadable' };
  } finally {
    // タイマーを解除する (放置するとプロセスが無駄に起き続ける)
    clearTimeout(timeoutHandle);
    // 残りのストリームを破棄する (読み続けてメモリを積まない)。
    // cancel() は「既にエラー状態のストリーム」に対しては reject するため、必ず握って捨てる:
    // ここで reject を伝播させると、上限超過で打ち切った判定が unreadable に化けてしまい、
    // サイズ攻撃のログが接続断のログとして記録される (両者は応答も監査行も同じなので、
    // ログだけが唯一の見分けどころ)
    void reader?.cancel().catch(() => {});
  }

  // 上限超過なら、確保したバッファは捨てて拒否を返す
  if (exceeded) return { ok: false, reason: 'too-large' };

  // 実際に読んだぶんだけに詰め直して返す (確保時は上限サイズなので、そのまま返すと
  // 本文の後ろにゼロ埋めが付いてしまう)
  return { ok: true, bytes: buffer.slice(0, totalBytes) };
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
 * @param timeoutMs 読み取り全体の制限時間 (既定 DEFAULT_BODY_READ_TIMEOUT_MS)
 */
export async function readFormWithinByteLimit(
  req: Request,
  maxBytes: number,
  timeoutMs: number = DEFAULT_BODY_READ_TIMEOUT_MS,
): Promise<BoundedFormResult> {
  // まずバイト列として上限つきで読む (超過・時間切れ・読み取り失敗はここで判別される)
  const body = await readBodyWithinByteLimit(req, maxBytes, timeoutMs);
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
