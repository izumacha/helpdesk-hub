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
// **上限値を決めるときは、本文サイズの約 3 倍を見込むこと。** 山は 2 つあり、時間帯が別なので
// 足し合わせず**大きい方**を取る:
//   - 読み取り中 … 最大 2 倍未満
//     (伸長は `Math.min(maxBytes, ...)` で頭打ちにするため、最後の 1 回だけ「倍々の途中サイズ
//      (= 旧) + maxBytes (= 新)」が同時に生きる。比は 1 + 旧/maxBytes で、maxBytes が
//      成長段 (16KiB×2^n) の**直上**にあるとき旧がほぼ maxBytes に等しくなり 2 倍に漸近する。
//      実測: 上限 2MiB+1 と 16MiB+1 でちょうど 2.000 倍。maxBytes が 2 の冪なら 1.5 倍。
//      旧バッファは `buffer = grown` の時点で参照が切れるので、次の山までは持ち越さない)
//   - 解析中 … 約 3 倍 (readFormWithinByteLimit を通る経路のみ)
//     (読み終えたバッファ 1 倍 ＋ `new Response(bytes)` のコピー 1 倍 ＋ `formData()` が作る
//      フィールド値のコピー 1 倍。Response がコピーを取ることの確認方法: 元の Uint8Array を
//      Response 生成後に書き換えてから arrayBuffer() を読むと、書き換え前の値が返る)
//   本文を読むだけの経路 (readTextWithinByteLimit) は解析側の山が無いので 2 倍未満で収まる。
//
// 関連: `webhook-fetch.ts` の `readBodyCapped` と `line-content.ts` の `readBodyCappedBytes` も
// 「ストリームを上限つきで読む」同種の処理だが、あちらは外向き fetch の **Response** が対象で
// 戻り値も用途ごとに違う (文字列 / 画像バイト列)。こちらは受信 **Request** 専用で、
// Content-Length の事前検査・制限時間・拒否理由の判別を持つ点も異なる。
// 3 者の統合は本モジュールの利用箇所が増えてから検討する。
//
// 採用状況: **自前でボディを読む 5 経路が本モジュール経由** (#287 で完了)。
//   `auth/sso/[tenantId]/acs` / `auth/magic-link/callback` (PR #286)
//   `inbound/line` / `inbound/email` / `webhooks/stripe` (#287。いずれも署名・共有シークレット
//   検証を通る経路のため、移行前後で検証結果が一致することを各ルートのテストで固めてある)
// 上限値の置き場: 前 2 経路はその経路の他の共有定数と同居 (`sso-rate-limit.ts` /
// `magic-link.ts`)、後 3 経路は `webhook-body-limits.ts`。いずれも route とテストが
// 同じ定義を参照する (片方だけ値を変えたら気付けるようにするため)。
//
// **middleware のセッション認証を素通りする POST はこの 5 つで全部ではない。**
// 正本は `src/middleware.ts` の除外条件で、下は「本モジュールの対象外である理由」の分類。
// 網羅リストとして数え上げるのではなく、**経路を足すたびに middleware 側から数え直すこと**
// (この一覧を信じて監査すると、増えた経路を見落とす)。
//   - 自前ではボディを読まない選択をしている … `INTERNAL_CRON_ROUTES`
//     (`api/internal/trial-reminders` / `api/internal/sla-reminders`) はヘッダだけを見て
//     ボディに触れないので、上限を掛ける対象がそもそも無い。読むようになった時点で対象になる。
//   - **フレームワークがボディを読むので差し替えられない** … `api/auth/[...nextauth]`
//     (middleware の `isApiAuth` が `/api/auth` 配下を丸ごと通す) は next-auth のハンドラが、
//     未認証で開いているページ (`/login` `/signup` `/invite` `/help`) に置いた Server Action
//     (`requestMagicLink` / `requestSignup` / `completeSignup` / `acceptInvitation` など) は
//     Next 自身が、それぞれボディを解析する。いずれも上限が掛かっておらず、塞ぐなら
//     アプリの外側 (リバースプロキシ or middleware での事前検査) が必要になる既知のギャップ。
// **自前でボディを読む未認証 POST 経路を足すときは、ここへ寄せて上限を必ず設けること。**

// チャンクが 1 つも届かないまま許容する最大時間 (slowloris 対策その 1)。
//
// 「送るのをやめた接続」をここで落とす。読み取り全体の期限**だけ**にしないのは、全体を
// 短く絞ると、上限サイズに近い本文を細い上り回線から送っている正規の利用者まで巻き添えに
// するため (例: 80KB のアサーションを 64kbps のモバイル回線から送ると 10 秒を超える。
// 現在の値は下記の理由で 30 秒なので、この例はさらに余裕をもって通る)。
// ACS の POST はユーザーのブラウザから飛ぶので、回線品質はこちらで選べない。
// タイマーは 1 チャンクごとに張り直す。
//
// **値を 30 秒にしているのは、このタイマーが「相手が送ってこない」と「こちらが詰まっていて
// 受け取れない」を区別できないため。** 実時間で測るので、メール取り込みが 25MB の multipart を
// 解析してイベントループを止めている間は、並行して読んでいる**別経路**のリクエストにも
// 無通信として積算される。10 秒だと、正常に送信中の SSO ACS / マジックリンクのコールバックが
// 巻き添えで打ち切られうる (この 2 経路は再送が無いので、利用者にはログイン失敗として出る)。
// 経路ごとに上書きするのではなく既定を上げるのは、詰まりを作る側と被る側が別経路だから。
// 延ばしても保持時間の上限は変わらない — slowloris を止めているのは張り直さない全体期限の方で、
// そちらは据え置いてある。
//
// 根本の対処 (タイマーをイベントループの停止に気付かせる / 同時に走るパースの本数を絞る) は
// 本モジュール単体では閉じないため別途とする。ここは余裕を揃えただけである点に注意。
const DEFAULT_BODY_IDLE_TIMEOUT_MS = 30_000;

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
const DEFAULT_BODY_TOTAL_TIMEOUT_MS = 120_000;

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
  // 本文を読み切れなかった。cause は常に undefined だが**キー自体は生やしておく**:
  // こうしておくと呼び出し元が reason で絞り込まずに `result.cause` をそのままログへ渡せる
  // (絞り込みの三項演算子を採用ルートごとに書き写さずに済む。§6 DRY)
  | { ok: false; reason: 'too-large' | 'timeout' | 'unreadable'; cause?: undefined }
  // フォームとして解析できなかった。**元の例外を捨てずに添えて返す** (§6 エラーを握り潰さない)。
  //
  // ただし今の undici から得られる情報は限られる (Node v22 で実測): multipart の失敗は
  // boundary 違い・パートの途中切れのいずれも `TypeError: Failed to parse body as FormData.` に
  // 潰れ、`cause` チェーンも付かない。理由まで判別できるのは Content-Type が
  // multipart / urlencoded のどちらでもない場合だけで、そのときは専用の文言が返る。
  // それでも捨てずに運ぶのは、(a) スタックから「どの呼び出しで落ちたか」は分かる、
  // (b) 上流が将来詳細を載せたらそのまま活きる、(c) 握り潰した実装だと後から足す動機が
  // 生まれない、の 3 点による。**この 1 行以上の切り分けを期待して上限値やパーサを
  // 設計しないこと。**
  | { ok: false; reason: 'unparsable'; cause: unknown };

// 本文を取り出せなかった理由。呼び出し元がログ文言の型を自前で導出しなくて済むよう公開する
export type BodyRejectReason = Exclude<BoundedFormResult, { ok: true }>['reason'];

// 「本文を読むだけ」の経路で起こりうる理由 (フォーム解析をしないので 'unparsable' は生じない)。
// readTextWithinByteLimit しか使わないルートが、到達しない文言をでっち上げずに済むよう公開する
export type BodyReadRejectReason = Exclude<BoundedTextResult, { ok: true }>['reason'];

// 拒否時にクライアントへ返す文言の一覧。**理由ごとに 1 つずつ決める**のが要点
// (引き方の理由は `body-reject-response.ts` の bodyRejectResponse を参照)。
// 型引数でその経路に起こりうる理由だけに絞れる — 本文を読むだけの経路なら
// `BodyRejectMessages<BodyReadRejectReason>` で 'unparsable' を書かずに済む。
//
// HTTP を一切参照しない純粋な型なので、`next/server` を import する
// `body-reject-response.ts` ではなくこちらに置く (あちらへ置くと、文言表を持つだけの
// モジュールが Next へ依存する形になり、分離した意味が薄れる)
export type BodyRejectMessages<R extends BodyRejectReason = BodyRejectReason> = Readonly<
  Record<R, string>
>;

/**
 * 拒否理由をサーバーログ用の日本語 1 行にする。
 *
 * 外部へ返す文言は経路が理由ごとに出し分ける (`bodyRejectResponse`) が、それはあくまで
 * 「大きすぎたのか、届き切らなかったのか」程度の粒度で、リダイレクトするだけの 2 経路
 * (sso-acs / magic-link コールバック) に至っては理由によらず同じ応答になる。
 * 「サイズ攻撃なのか、だらだら送りなのか、壊れたクライアントなのか」を運用者が後から
 * 見分けられる手がかりはこのログだけなので、文言をここに集約して各ルートに書き写さない。
 * 本文の中身は決して含めない (§9 PII をログに漏らさない)。
 *
 * export しないのは、全ルートが logBodyReject 経由になり外部から名指しで呼ぶ必要が
 * 無くなったため (§6 デッドコードを残さない)。公開したままにすると logBodyReject を
 * 迂回して各ルートが console.warn を書き直す余地を残してしまう。
 *
 * @param reason 読み取りが失敗した理由
 * @param maxBytes 適用していた上限バイト数 (サイズ超過の文言に載せる)
 */
function describeBodyRejectReason(reason: BodyRejectReason, maxBytes: number): string {
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
 * 呼び出し元は `bodyRejectResponse` だけで、各ルートは直接呼ばない (ルートは応答の組み立てごと
 * あちらに委ねる)。それでも理由の定義と同じ場所に置いてあるのは、理由を増やしたときに
 * 「説明文・ステータス・文言」の 3 点セットを 1 画面で見直せるようにするため。
 * **新しいルートがここを直接呼んで NextResponse を手組みしないこと** — それをやると
 * bodyRejectResponse が消した 4 行の複製が戻る。
 *
 * @param reason 読み取りが失敗した理由
 */
export function bodyRejectStatus(reason: BodyRejectReason): 413 | 400 {
  // 上限超過だけが「大きすぎる」= 413。残りは本文を受け取れなかったので形式不正扱いの 400
  return reason === 'too-large' ? 413 : 400;
}

/**
 * 拒否理由 (と、あれば原因の例外) をサーバーログへ 1 行で残す。
 *
 * 本モジュールを使う 5 経路すべてが「拒否したらログに 1 行残す」を必要とし、うち 3 経路は
 * さらに JSON 応答を返す (`bodyRejectResponse`)、2 経路はリダイレクトするだけ、と後段が
 * 分かれる。**ログの出し方だけは 5 経路で揃える**ためにここへ置く (§6 DRY)。
 *
 * @param logPrefix ログ行の先頭に付ける識別子。**角括弧まで含めて渡す**
 *   (例: '[sso-acs]')。`quarantine.ts` / `settings-audit.ts` の同名引数と同じ約束にしてある
 *   — 片方だけ括弧を足す形にすると、隣の呼び出しを写した実装が `[[sso-acs]]` になる
 * @param reason 読み取りが失敗した理由
 * @param maxBytes 適用していた上限バイト数 (サイズ超過の文言に載せる)
 * @param cause 原因の例外 (フォーム解析に失敗したときだけ入る)
 */
export function logBodyReject(
  logPrefix: string,
  reason: BodyRejectReason,
  maxBytes: number,
  cause?: unknown,
): void {
  // 理由の説明文を組み立てる (本文の中身は含まない。§9 PII をログに漏らさない)
  const detail = describeBodyRejectReason(reason, maxBytes);
  // 原因の例外があれば同じ行に添える (無いときに undefined を渡すと行末に "undefined" が出る)
  if (cause === undefined) console.warn(`${logPrefix} ${detail}`);
  else console.warn(`${logPrefix} ${detail}`, cause);
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
  } catch (err) {
    // Content-Type 不一致・本文破損など。**例外を捨てずに結果へ載せて返す** —
    // ログ自体は呼び出し元が文脈 (どのルートか) を付けて出すが、原因が分かるのはこの例外だけなので
    // ここで消してしまうと呼び出し元が何を出しても「解析できませんでした」以上のことを言えない
    return { ok: false, reason: 'unparsable', cause: err };
  }
}
