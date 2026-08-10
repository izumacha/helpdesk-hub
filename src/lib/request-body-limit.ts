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
//      ワイヤ上はわずか約 6MB で足りる)。そのため**1 本の連続したバッファへ書き込む**形にし、
//      メモリ使用量をチャンク数から独立させる (確保の仕方は下の「メモリの目安」を参照)。
//   3. **slowloris (だらだら送り)** → 上限に届かない速度で送られるとループは終わらず、
//      ハンドラと接続が保持され続ける。**無通信時間の上限だけでは足りない** (その直前に
//      1 バイトずつ送ればタイマーを永久に張り直せる) ため、無通信の上限と、張り直さない
//      全体期限の 2 本立てで打ち切る。
//
// メモリの目安: 保持するのは「実際の本文サイズ」ぶんのバッファ 1 本で、チャンク数には依存しない。
// 上限ぶんを先に確保することはせず、INITIAL_BUFFER_BYTES から始めて足りなければ倍々に伸ばす
// (通常の SAML アサーションは数十 KB なので、毎回 1MB を確保するのは無駄なため)。
// **上限値を決めるときは、本文サイズの約 3.5 倍を見込むこと。** 内訳:
//   - バッファを伸ばす瞬間だけ新旧が並ぶ … 最大 1.5 倍
//   - readFormWithinByteLimit の `new Response(bytes)` … もう 1 倍
//     (Response はバイト列を参照せずコピーする。確認方法: 元の Uint8Array を Response 生成後に
//      書き換えてから arrayBuffer() を読むと、書き換え前の値が返る)
//   - formData() が作るフィールド値のコピー … もう 1 倍
//
// 関連: `webhook-fetch.ts` の `readBodyCapped` と `line-content.ts` の `readBodyCappedBytes` も
// 「ストリームを上限つきで読む」同種の処理だが、あちらは外向き fetch の **Response** が対象で
// 戻り値も用途ごとに違う (文字列 / 画像バイト列)。こちらは受信 **Request** 専用で、
// Content-Length の事前検査・制限時間・拒否理由の判別を持つ点も異なる。
// 3 者の統合は本モジュールの利用箇所が増えてから検討する。
//
// 採用状況 (未認証で到達できる POST 経路): **全 5 経路が本モジュール経由** (#287 で完了)。
//   `auth/sso/[tenantId]/acs` / `auth/magic-link/callback` (PR #286)
//   `inbound/line` / `inbound/email` / `webhooks/stripe` (#287。いずれも署名・共有シークレット
//   検証を通る経路のため、移行前後で検証結果が一致することを各ルートのテストで固めてある)
// 上限値の置き場: 前 2 経路はその経路の他の共有定数と同居 (`sso-rate-limit.ts` /
// `magic-link.ts`)、後 3 経路は `webhook-body-limits.ts`。いずれも route とテストが
// 同じ定義を参照する (片方だけ値を変えたら気付けるようにするため)。
// **新しく未認証 POST 経路を足すときは、ここへ寄せて上限を必ず設けること。**

// チャンクが 1 つも届かないまま許容する最大時間 (slowloris 対策その 1)。
//
// 「送るのをやめた接続」をここで落とす。読み取り全体の期限**だけ**にしないのは、全体を
// 短く絞ると、上限サイズに近い本文を細い上り回線から送っている正規の利用者まで巻き添えに
// するため (例: 80KB のアサーションを 64kbps のモバイル回線から送ると 10 秒を超える)。
// ACS の POST はユーザーのブラウザから飛ぶので、回線品質はこちらで選べない。
// タイマーは 1 チャンクごとに張り直す
export const DEFAULT_BODY_IDLE_TIMEOUT_MS = 10_000;

// 読み取り開始から完了までに許容する最大時間 (slowloris 対策その 2)。
//
// **無通信時間の上限だけでは slowloris は止まらない。** 攻撃者は「無通信の許容時間の直前に
// 1 バイトだけ送る」を繰り返せばタイマーを永久に張り直せてしまい、1 バイト / 9.9 秒なら
// 上限 1MB に到達するまで数か月ハンドラを保持できる。レート制限は「開始したリクエスト数」
// しか数えず同時保持数を絞らないので、毎分 60 本ずつ積み上げれば FD とメモリを枯渇させられる。
// そこで無通信の上限に加えて、張り直さない全体期限も併せて置く。
//
// 値は「正規の利用者を落とさない範囲でできるだけ短く」で決める。120 秒あれば 64kbps の
// 細い回線でも約 960KB (上限 1MB のほぼ全域) を送り切れるので、実際のアサーション
// (数十 KB) が巻き添えになる余地は無い。Node 既定の requestTimeout (300 秒) より十分短い
export const DEFAULT_BODY_TOTAL_TIMEOUT_MS = 120_000;

// 最初に確保するバッファのサイズ。小さな本文 (通常の SAML アサーションは数十 KB) のために
// 上限ぶんを毎回確保するのは無駄なので、ここから始めて足りなければ倍々に伸ばす
const INITIAL_BUFFER_BYTES = 16 * 1024;

// バイト列としての読み取り結果。
// bytes を Uint8Array で返すのは、そのまま Response/Request の body に渡せる型 (BodyInit) で、
// かつ内部バッファの一部を切り出す際にコピーを作らずに済む (subarray) から。
// export しないのは呼び出し元が戻り値を型注釈せずに使えるため (§6 デッドコードを残さない)。
// 外部から名指しで必要になった時点で export に変える
type BoundedBodyResult =
  // ArrayBuffer 実体に紐づく Uint8Array に限定する (BodyInit として受け付けてもらうため。
  // 既定の Uint8Array<ArrayBufferLike> は SharedArrayBuffer 由来も含むので body に渡せない)
  | { ok: true; bytes: Uint8Array<ArrayBuffer> } // 上限内で読み切れた
  | { ok: false; reason: 'too-large' } // 上限超過 (ヘッダ申告 or ストリームの累計)
  | { ok: false; reason: 'timeout' } // 無通信が続いて打ち切った (だらだら送り)
  | { ok: false; reason: 'unreadable' }; // ストリームの読み取り自体に失敗した (接続断など)

// 文字列としての読み取り結果 (バイト列の結果の bytes を text に置き換えたもの)
type BoundedTextResult =
  | { ok: true; text: string } // 上限内で読み切れて UTF-8 として復号できた
  | { ok: false; reason: 'too-large' | 'timeout' | 'unreadable' };

// フォームとしての読み取り結果 (バイト列の結果に「パースできなかった」を足したもの)
type BoundedFormResult =
  | { ok: true; form: FormData } // 上限内で読み取れてフォームとしてパースできた
  | { ok: false; reason: 'too-large' | 'timeout' | 'unreadable' | 'unparsable' };

// 本文を取り出せなかった理由。呼び出し元がログ文言の型を自前で導出しなくて済むよう公開する
export type BodyRejectReason = Exclude<BoundedFormResult, { ok: true }>['reason'];

/**
 * 拒否理由をサーバーログ用の日本語 1 行にする。
 *
 * 呼び出し元 (ルート) は理由で処理を分けないが、応答も監査行も理由によらず同じになるため、
 * 「サイズ攻撃なのか、だらだら送りなのか、壊れたクライアントなのか」を後から見分けられる
 * 唯一の手がかりがこのログになる。文言をここに集約して、採用するルートごとに書き写さない。
 * 本文の中身は決して含めない (§9 PII をログに漏らさない)。
 *
 * @param reason 読み取りが失敗した理由
 * @param maxBytes 適用していた上限バイト数 (サイズ超過の文言に載せる)
 */
export function describeBodyRejectReason(reason: BodyRejectReason, maxBytes: number): string {
  // Record にして網羅性を型で強制する (理由を増やしたらキー不足で typecheck が落ちる)
  const descriptions: Readonly<Record<BodyRejectReason, string>> = {
    'too-large': `リクエストボディが上限 ${maxBytes} バイトを超えました。`,
    timeout: 'リクエストボディの送信が途中で止まりました (だらだら送りの疑い)。',
    unreadable: 'リクエストボディの読み取りに失敗しました (接続断など)。',
    unparsable: 'リクエストボディをフォームとして解析できませんでした。',
  };
  // 該当する説明を返す
  return descriptions[reason];
}

/**
 * 拒否理由を HTTP ステータスへ振り分ける。
 *
 * 「サイズ超過は 413、それ以外 (だらだら送り・接続断・パース不能) は 400」という同じ判断が、
 * 本モジュールを採用する各ルートに繰り返し必要になるため、理由の定義と同じ場所に置いて
 * 書き写しを防ぐ (§6 DRY)。理由を増やしたときの振り分け漏れもここだけ見れば済む。
 *
 * @param reason 読み取りが失敗した理由
 */
export function bodyRejectStatus(reason: BodyRejectReason): 413 | 400 {
  // 上限超過だけが「大きすぎる」= 413。残りは本文を受け取れなかったので形式不正扱いの 400
  return reason === 'too-large' ? 413 : 400;
}

/**
 * リクエストボディを最大 `maxBytes` バイトまで読み取る。
 *
 * 四段構え:
 *   1. Content-Length の申告が上限超過なら、本文を一切読み進めずに打ち切る。
 *   2. 申告が無い/過少申告でも、ストリームの累計バイト数が上限を超えた時点で打ち切る。
 *   3. 次のチャンクが `idleTimeoutMs` 待っても届かなければ打ち切る (送るのをやめた接続)。
 *   4. 3 を満たし続けても、開始から `totalTimeoutMs` を超えたら打ち切る
 *      (無通信の上限だけだと、その直前に 1 バイトずつ送ってタイマーを永久に張り直せる)。
 *
 * 3 と 4 は役割が違うので両方要る: 3 だけでは上のトリクル攻撃を止められず、
 * 4 だけでは細い上り回線の正規クライアントを巻き添えにする。
 *
 * @param req 読み取り対象のリクエスト (ボディは呼び出し後に消費済みになる)
 * @param maxBytes 許容する最大バイト数 (この値ちょうどまでは許可し、超えた分を拒否する)
 * @param idleTimeoutMs 次のチャンクを待つ最大時間 (既定 DEFAULT_BODY_IDLE_TIMEOUT_MS)
 * @param totalTimeoutMs 読み取り全体の最大時間 (既定 DEFAULT_BODY_TOTAL_TIMEOUT_MS)
 */
export async function readBodyWithinByteLimit(
  req: Request,
  maxBytes: number,
  idleTimeoutMs: number = DEFAULT_BODY_IDLE_TIMEOUT_MS,
  totalTimeoutMs: number = DEFAULT_BODY_TOTAL_TIMEOUT_MS,
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
  if (!req.body) return { ok: true, bytes: new Uint8Array(0) };

  // チャンクの書き込み先。足りなくなったら倍々に伸ばし、上限で頭打ちにする。
  // チャンクを配列に溜めない (溜めると 1 バイト刻みの chunked 転送で Uint8Array
  // オブジェクトが本文バイト数だけ積まれ、1MB の本文で 229MB を保持してしまう)
  let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(Math.min(INITIAL_BUFFER_BYTES, maxBytes));
  // ここまでに書き込んだ累計バイト数
  let totalBytes = 0;
  // 上限超過を検知したか (検知したら読み取りをやめる)
  let exceeded = false;
  // 時間切れ (無通信 or 全体期限) で打ち切ったか
  let timedOut = false;
  // ストリームのリーダー (finally で確実に cancel するため try の外で宣言する)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  // 無通信を検知するタイマー (チャンクごとに張り直す。finally で必ず解除する)
  let idleTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  // 全体期限のタイマー (開始時に 1 度だけ張り、張り直さない。finally で必ず解除する)
  let totalTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    // ストリームを 1 チャンクずつ読むためのリーダーを取得する
    // (ボディが他所でロック済みなら例外になるため、try の中で呼ぶ)
    reader = req.body.getReader();
    // タイマーのコールバックから参照するためのローカル束縛 (undefined でないことが確定している)
    const activeReader = reader;
    // 時間切れで読み取りを止める共通処理。リーダーを cancel すると待機中の read() は
    // done で解決するので、ループは自然に抜ける。
    // Promise.race で待つ実装にしてはいけない: 解決しない Promise に対する反応 (PromiseReaction) が
    // 1 チャンクごとに積み上がり、チャンク数に比例したメモリを保持してしまう
    // (実測: 1 バイト刻みで 1MB を送ると +566MB。この方式なら +4MB 程度に収まる)
    const abortAsTimedOut = () => {
      timedOut = true;
      void activeReader.cancel().catch(() => {});
    };
    // 次のチャンクを待つタイマーを張り直す (送るのをやめた接続を落とす)
    const armIdleTimeout = () => {
      // 前のチャンク用に張ったタイマーを解除してから張り直す (無通信タイマーは常に 1 本だけ)
      clearTimeout(idleTimeoutHandle);
      idleTimeoutHandle = setTimeout(abortAsTimedOut, idleTimeoutMs);
    };
    // 全体期限のタイマーを張る。**張り直さない**のが要点で、これが無いと攻撃者は
    // 無通信の許容時間の直前に 1 バイトずつ送るだけでハンドラを無期限に保持できてしまう
    totalTimeoutHandle = setTimeout(abortAsTimedOut, totalTimeoutMs);
    // 最初のチャンクを待つぶんの無通信タイマーを張る
    armIdleTimeout();

    // ストリームの終端に達するまで読み続ける
    for (;;) {
      // 次のチャンクを 1 つ読む
      const { done, value } = await reader.read();
      // チャンクが届いた (or 終端に達した) ので、無通信の計測をここから数え直す。
      // これにより「遅いが送り続けている」正規クライアントは何秒かかっても通り、
      // 「送るのをやめた」接続だけが次の待機で時間切れになる
      armIdleTimeout();
      // 終端に達したらループを抜ける (時間切れの cancel もここで done になる)
      if (done) break;
      // 上限を超えるなら、書き込まずに打ち切る
      if (totalBytes + value.byteLength > maxBytes) {
        exceeded = true;
        break;
      }
      // バッファが足りなければ倍々で伸ばす (必要量に足りない場合はその量まで一気に伸ばす)
      if (totalBytes + value.byteLength > buffer.length) {
        // 次のサイズ: 現在の 2 倍か必要量の大きい方。ただし上限は超えない
        const nextSize = Math.min(
          maxBytes,
          Math.max(buffer.length * 2, totalBytes + value.byteLength),
        );
        // 新しいバッファへ既存分を移す
        const grown = new Uint8Array(nextSize);
        grown.set(buffer.subarray(0, totalBytes));
        buffer = grown;
      }
      // バッファの続きへ書き込む
      buffer.set(value, totalBytes);
      // 累計バイト数を進める
      totalBytes += value.byteLength;
    }
  } catch {
    // 時間切れで cancel した直後に相手側のソケットがエラーになると、待機中の read() が
    // done ではなく reject でここへ来ることがある。その場合の実体は「時間切れ」なので
    // unreadable に化けさせない (応答も監査行も理由によらず同じで、このログだけが
    // サイズ攻撃・だらだら送り・接続断を見分ける唯一の手がかりになるため)
    if (timedOut) return { ok: false, reason: 'timeout' };
    // 途中で切れた接続・壊れたストリームなど。呼び出し元が拒否理由を出し分けられるよう返す
    // (例外を投げ直さないのは、呼び出し元が「拒否」以外の選択肢を持たないため。ログは呼び出し元が出す)
    return { ok: false, reason: 'unreadable' };
  } finally {
    // タイマーを 2 本とも解除する (放置するとプロセスが無駄に起き続ける)
    clearTimeout(idleTimeoutHandle);
    clearTimeout(totalTimeoutHandle);
    // 残りのストリームを破棄する (読み続けてメモリを積まない)。
    // cancel() は「既にエラー状態のストリーム」に対しては reject するため、必ず握って捨てる:
    // ここで reject を伝播させると、上限超過で打ち切った判定が unreadable に化けてしまい、
    // サイズ攻撃のログが接続断のログとして記録される (両者は応答も監査行も同じなので、
    // ログだけが唯一の見分けどころ)
    void reader?.cancel().catch(() => {});
  }

  // 時間切れでの打ち切り (だらだら送り) は、読めた量に関わらず拒否する
  if (timedOut) return { ok: false, reason: 'timeout' };
  // 上限超過なら、確保したバッファは捨てて拒否を返す
  if (exceeded) return { ok: false, reason: 'too-large' };

  // 実際に読んだぶんだけを切り出して返す (subarray なのでコピーは発生しない)
  return { ok: true, bytes: buffer.subarray(0, totalBytes) };
}

// 復号器はステートレスなので 1 つを使い回す (リクエストごとに生成しない)
const UTF8_DECODER = new TextDecoder();

/**
 * リクエストボディをバイト数上限つきで読み取り、UTF-8 の文字列として返す。
 *
 * **実運用で起こりうる本文については `req.text()` と結果が一致する。** どちらも同じ WHATWG の
 * UTF-8 復号を通るため、先頭 BOM の除去も、不正なバイト列が置換文字 (U+FFFD) になる挙動も
 * 同じ結果になる (BOM 無し / BOM 1 つ / 不正バイト列を含む本文で一致することを確認済み)。
 * この等価性は署名検証 (LINE の HMAC / Stripe の constructEvent) を通る経路で決定的に重要
 * ——復号が 1 箇所でも崩れると正規のリクエストが軒並み署名不一致で拒否される——ため、
 * 呼び出し元がそれぞれ TextDecoder を書くのではなく、根拠ごとここに 1 つだけ置く (§6 DRY)。
 *
 * **唯一の差異: BOM が 2 つ以上連続する本文。** undici の `req.text()` は BOM を自前で 1 つ
 * 剥がしてから TextDecoder に渡すため二重に剥がれ、こちらは 1 つだけ剥がす。実在の送信者が
 * こんな本文を送ることはなく、かつ**どちらの結果でも署名は不一致になる**ので、検証が緩む方向
 * (署名鍵を持たない相手の偽造が通る方向) の差ではない。この挙動は
 * `tests/request-body-limit.test.ts` で固定してある。
 *
 * 署名検証に使うなら、本関数ではなく `readBodyWithinByteLimit` の生バイト列を直接
 * HMAC にかける方が理屈の上ではより厳密 (復号を挟まないぶん、不正な UTF-8 でも送信者が
 * 署名したバイト列そのものを検証できる)。現在は移行前の `req.text()` との等価性を優先している。
 *
 * @param req 読み取り対象のリクエスト
 * @param maxBytes 許容する最大バイト数
 * @param idleTimeoutMs 次のチャンクを待つ最大時間 (既定 DEFAULT_BODY_IDLE_TIMEOUT_MS)
 * @param totalTimeoutMs 読み取り全体の最大時間 (既定 DEFAULT_BODY_TOTAL_TIMEOUT_MS)
 */
export async function readTextWithinByteLimit(
  req: Request,
  maxBytes: number,
  idleTimeoutMs: number = DEFAULT_BODY_IDLE_TIMEOUT_MS,
  totalTimeoutMs: number = DEFAULT_BODY_TOTAL_TIMEOUT_MS,
): Promise<BoundedTextResult> {
  // まずバイト列として上限つきで読む (超過・時間切れ・読み取り失敗はここで判別される)
  const body = await readBodyWithinByteLimit(req, maxBytes, idleTimeoutMs, totalTimeoutMs);
  // 読めなかった理由はそのまま呼び出し元へ渡す
  if (!body.ok) return body;
  // 読み取れたバイト列を UTF-8 の文字列に復号して返す
  return { ok: true, text: UTF8_DECODER.decode(body.bytes) };
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
 * @param idleTimeoutMs 次のチャンクを待つ最大時間 (既定 DEFAULT_BODY_IDLE_TIMEOUT_MS)
 * @param totalTimeoutMs 読み取り全体の最大時間 (既定 DEFAULT_BODY_TOTAL_TIMEOUT_MS)
 */
export async function readFormWithinByteLimit(
  req: Request,
  maxBytes: number,
  idleTimeoutMs: number = DEFAULT_BODY_IDLE_TIMEOUT_MS,
  totalTimeoutMs: number = DEFAULT_BODY_TOTAL_TIMEOUT_MS,
): Promise<BoundedFormResult> {
  // まずバイト列として上限つきで読む (超過・時間切れ・読み取り失敗はここで判別される)
  const body = await readBodyWithinByteLimit(req, maxBytes, idleTimeoutMs, totalTimeoutMs);
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
