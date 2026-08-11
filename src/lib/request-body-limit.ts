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
// 採用状況: **自前でボディを読む経路はすべて本モジュール経由** (未認証 5 経路 ＋ 認証済み 2 経路)。
//   `auth/sso/[tenantId]/acs` / `auth/magic-link/callback` (PR #286)
//   `inbound/line` / `inbound/email` / `webhooks/stripe` (#287。いずれも署名・共有シークレット
//   検証を通る経路のため、移行前後で検証結果が一致することを各ルートのテストで固めてある)
//   `api/tickets` (multipart / JSON の両方) / `api/tickets/[id]/comments` (#290 フォローアップ。
//   認証済みだが「1 リクエストで確保できる量が無制限」という性質は未認証経路と同じだった)
// **ただし `inbound/line` はこの等価性を #290 で意図的に捨てた。** 署名対象を復号後の文字列から
// 受信バイト列そのものへ変えたため、BOM 付き・不正 UTF-8 の本文では移行前 (401) と結果が変わる
// (現在は 200 で取り込む)。等価性ではなく「バイト列に対する署名が通ること」を固定する形へ
// テストも差し替えてある。詳細は readTextWithinByteLimit の docstring を参照。
// 上限値の置き場: 最初の 2 経路はその経路の他の共有定数と同居 (`sso-rate-limit.ts` /
// `magic-link.ts`)、受信 Webhook 3 経路は `webhook-body-limits.ts`、認証済みのチケット
// 書き込み 2 経路は `ticket-body-limits.ts`。いずれも route とテストが同じ定義を参照する
// (片方だけ値を変えたら気付けるようにするため)。
//
// **middleware のセッション認証を素通りする POST は、上の未認証 5 経路で全部ではない。**
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
//
// **認証済みの経路も移行済み** (#290 フォローアップ)。`POST /api/tickets` と
// `POST /api/tickets/[id]/comments` は `req.formData()` / `req.json()` を直接呼んでいて上限が
// 無かった (添付の 1 件あたりのサイズ検査は、ボディを全部メモリへ載せた**後**に走る)。
// ログイン済みしか到達できず 1 分あたりの本数も別途絞ってあるぶん未認証経路より優先度は
// 低かったが、**Content-Length を省いた chunked 転送なら上限なく展開できる**性質は同じだった。
// 添付付き経路の上限は「件数 × 1 件あたりのサイズ」のドメイン定数から導出してある
// (`ticket-body-limits.ts`)。ここを直書きにすると、添付の上限を引き上げたときに枠だけが
// 古い値のまま残り、正規のアップロードを 413 で弾く。
//
// **新しく POST 経路を足すときは、未認証・認証済みを問わず、ここへ寄せて上限を設けること。**

// チャンクが 1 つも届かないまま許容する最大時間 (slowloris 対策その 1)。
//
// 「送るのをやめた接続」をここで落とす。読み取り全体の期限**だけ**にしないのは、全体を
// 短く絞ると、上限サイズに近い本文を細い上り回線から送っている正規の利用者まで巻き添えに
// するため (例: 80KB のアサーションを 64kbps のモバイル回線から送ると 10 秒を超える。
// その手の経路は下の STALL_TOLERANT_BODY_IDLE_TIMEOUT_MS を明示的に使う)。
// ACS の POST はユーザーのブラウザから飛ぶので、回線品質はこちらで選べない。
// タイマーは 1 チャンクごとに張り直す。
//
// **短くしておくのが既定。** ヘッダだけ送って本文を送らない接続は、この時間ぶん reader と
// INITIAL_BUFFER_BYTES のバッファとソケットの FD を掴む。同時に生きる本数は「開始レート ×
// この値」に比例する一方、下の全体期限のコメントにあるとおりレート制限は開始数しか数えず
// **同時保持数は絞らない**ので、値を延ばした分がそのまま保持数に効く。
//
// export しているのはテストが参照するため (§9 に効く値なので、満たすべき関係を固定してある)。
export const DEFAULT_BODY_IDLE_TIMEOUT_MS = 10_000;

// 無通信の許容時間を延ばした版 (30 秒)。**イベントループの停止に巻き込まれても
// 落ちてほしくない経路だけ**が明示的に使う。
//
// このタイマーは実時間で測るので「相手が送ってこない」と「こちらが詰まっていて受け取れない」を
// 区別できない。メール取り込みが 25MB の multipart を解析している間はループが止まり、並行して
// 読んでいる**別経路**のリクエストにも無通信として積算される。既定の 10 秒では、正常に送信中の
// SSO ACS / マジックリンクのコールバックが巻き添えで打ち切られうる。
//
// **既定そのものを延ばさず、使う経路を選ぶ**のが要点。
//
// 延ばせば同時保持数は素直に増える (上の既定のコメントどおり「開始レート × この値」に比例し、
// 10 秒 → 30 秒なら 3 倍)。**ゲートが効くのは増加を消すことではなく、増加幅を見積もれる形に
// 抑えること**: 読み取りの前にレート制限があれば保持数は「その上限 × この値」で頭打ちになる
// (例: 60/分 × 30 秒 ≒ 30 本)。ゲートが無ければ増加幅は攻撃者の接続レート次第になる。
// そこで採用条件は **「読み取りの前に何らかのゲートを通ること」** とし、そのうえで
// 「延ばす利益が増加分に見合うか」を経路ごとに見る。
// 現在の採用は 5 経路:
//   - `auth/sso/[tenantId]/acs` / `auth/magic-link/callback` … 読み取り前にレート制限を通る。
//     加えて**再送が無い**ので、誤って打ち切るとユーザーにはログイン失敗として出て取り返せない
//     (延長の動機が最も強い)。
//   - `inbound/email` … 読み取り前に共有シークレットの照合を通る。再送はあるが、
//     **自分の 25MB の解析でループを止める側**でもあるので、同時に届いた別のメールを
//     自分で巻き添えにしないために使う。
//   - `api/tickets` / `api/tickets/[id]/comments` … 読み取り前に `auth()`・同一オリジン検証・
//     ユーザー単位のレート制限 (20 件/分) を通る。**再送が無い**側でもある (打ち切ると利用者が
//     フォームから手で送り直すしかなく、モバイル回線からの添付送信では取り返しが重い)。
//     加えて 51MB の multipart を解析する側でもあるので、`inbound/email` と同じ「自分の解析で
//     他経路を巻き添えにしない」動機も持つ。
// `inbound/line` は使わない: 読み取りの前にゲートが無い唯一の経路 (レート制限は読み取りより
// 後ろに置いてある。理由はあちらのコメント) なので、延ばすとゲート無しの保持数だけが増える。
// 再送があるぶん、誤って打ち切っても取り返せる側でもある。
//
// 根本の対処 (タイマーをイベントループの停止に気付かせる / 同時に走るパースの本数を絞る) は
// 本モジュール単体では閉じないため別途とする。ここは巻き添えを避けているだけである点に注意。
export const STALL_TOLERANT_BODY_IDLE_TIMEOUT_MS = 30_000;

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
  // 上限超過 (ヘッダ申告 or ストリームの累計)。**申告が読めていれば、どちらで打ち切っても
  // declaredLength を載せる。** 申告より実データが大きい (過少申告で手前の検査をすり抜けた)
  // ケースこそ切り分けたい対象なので、ストリーム側で止めたときも申告値は捨てない
  // (実サイズの方は、上限で読むのをやめる設計上そもそも分からない)
  | { ok: false; reason: 'too-large'; declaredLength?: number }
  // 以下 2 つに declaredLength は付かないが、キーは生やしておく (呼び出し元が reason で
  // 絞り込まずにそのままログへ渡せるようにするため。cause と同じ理由)
  | { ok: false; reason: 'timeout'; declaredLength?: undefined } // 無通信が続いて打ち切った
  | { ok: false; reason: 'unreadable'; declaredLength?: undefined }; // 読み取り自体に失敗した

// 文字列としての読み取り結果 (バイト列の結果の bytes を text に置き換えたもの)
type BoundedTextResult =
  | { ok: true; text: string } // 上限内で読み切れて UTF-8 として復号できた
  | Exclude<BoundedBodyResult, { ok: true }>;

// フォームとしての読み取り結果 (バイト列の結果に「パースできなかった」を足したもの)
type BoundedFormResult =
  | { ok: true; form: FormData } // 上限内で読み取れてフォームとしてパースできた
  // 本文を読み切れなかった。cause は常に undefined だが**キー自体は生やしておく**:
  // こうしておくと呼び出し元が reason で絞り込まずに `result.cause` をそのままログへ渡せる
  // (絞り込みの三項演算子を採用ルートごとに書き写さずに済む。§6 DRY)
  | (Exclude<BoundedBodyResult, { ok: true }> & { cause?: undefined })
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
  | { ok: false; reason: 'unparsable'; cause: unknown; declaredLength?: undefined };

// 本文を取り出せなかった理由。呼び出し元がログ文言の型を自前で導出しなくて済むよう公開する
export type BodyRejectReason = Exclude<BoundedFormResult, { ok: true }>['reason'];

// 読み取りに失敗したときの結果そのもの。**呼び出し元が自前で書き写さずに済むよう公開する。**
// 書き写すと `{ reason: BodyRejectReason; cause?: unknown }` のように広げてしまいがちで、
// 「cause が付くのは unparsable のときだけ」という対応関係が型から落ちる
// (= timeout に cause を添える実装がコンパイルを通ってしまう)
export type BodyRejectFailure = Exclude<BoundedFormResult, { ok: true }>;

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
 * @param declaredLength Content-Length の申告値。読めていればそのまま載せ、読めていなければ
 *   「申告は無し」と明示する (数字をでっち上げない)。上限値だけでは全部の行が同じ文言になり、
 *   「正規の送信者が上限を少し超えている」と「桁違いで探られている」を区別できないため
 */
function describeBodyRejectReason(
  reason: BodyRejectReason,
  maxBytes: number,
  declaredLength?: number,
): string {
  // 申告サイズが読めていれば載せる。**上限値だけでは全部の行が同じ文言になり、
  // 「正規の送信者が上限より少し大きいものを送り続けている (上限の見直しどき)」と
  // 「桁違いのサイズで探られている」を運用者が区別できない** (上限はソースを見れば分かる値)。
  // ストリーム側で打ち切った場合は、設計上「上限を踏み越えた時点で読むのをやめる」ので
  // 実サイズは分からない。その場合は申告が無かった旨だけを残す
  const declared =
    declaredLength !== undefined && declaredLength >= 0
      ? `Content-Length の申告は ${declaredLength} バイト`
      : 'Content-Length の申告は無し (実サイズは上限で打ち切ったため不明)';
  // Record にして網羅性を型で強制する (理由を増やしたらキー不足で typecheck が落ちる)
  const descriptions: Readonly<Record<BodyRejectReason, string>> = {
    'too-large': `リクエストボディが上限 ${maxBytes} バイトを超えました (${declared})。`,
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
 * 本モジュールを使う 7 経路すべてが「拒否したらログに 1 行残す」を必要とし、うち 5 経路は
 * さらに JSON 応答を返す (`bodyRejectResponse`)、2 経路 (sso-acs / magic-link コールバック) は
 * リダイレクトするだけ、と後段が分かれる。**ログの出し方だけは 7 経路で揃える**ため
 * ここへ置く (§6 DRY)。
 *
 * @param logPrefix ログ行の先頭に付ける識別子。**角括弧まで含めて渡す**
 *   (例: '[sso-acs]')。`quarantine.ts` / `settings-audit.ts` の同名引数と同じ約束にしてある
 *   — 片方だけ括弧を足す形にすると、隣の呼び出しを写した実装が `[[sso-acs]]` になる
 * @param failure 読み取りに失敗した結果そのもの (理由・原因の例外・申告サイズを持つ)
 * @param maxBytes 適用していた上限バイト数 (サイズ超過の文言に載せる)
 */
export function logBodyReject(
  logPrefix: string,
  // **読み取り結果そのものを受け取る。** 中身 (reason / cause / declaredLength) を呼び出し元で
  // ばらして渡す形にすると、7 経路すべてが同じ分解を書き写すうえ、cause が unknown なので
  // declaredLength と取り違えても typecheck を通ってしまう ('unparsable' 以外は cause が
  // undefined なので、ほぼ全ケースで成立してしまう)。丸ごと渡せばどちらも起きない
  failure: BodyRejectFailure,
  maxBytes: number,
): void {
  // 理由の説明文を組み立てる (本文の中身は含まない。§9 PII をログに漏らさない)
  const detail = describeBodyRejectReason(failure.reason, maxBytes, failure.declaredLength);
  // 原因の例外があれば同じ行に添える (無いときに undefined を渡すと行末に "undefined" が出る)
  if (failure.cause === undefined) console.warn(`${logPrefix} ${detail}`);
  else console.warn(`${logPrefix} ${detail}`, failure.cause);
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
    return { ok: false, reason: 'too-large', declaredLength };
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
  // 上限超過なら、確保したバッファは捨てて拒否を返す。
  // 申告が読めていたならここでも載せる — ここへ来たということは「申告は上限内なのに実データが
  // 上限を超えた」= 過少申告なので、正直な送信者と区別するための一番の手がかりになる
  if (exceeded) {
    return Number.isFinite(declaredLength) && declaredLength >= 0
      ? { ok: false, reason: 'too-large', declaredLength }
      : { ok: false, reason: 'too-large' };
  }

  // 実際に読んだぶんだけを切り出して返す (subarray なのでコピーは発生しない)
  return { ok: true, bytes: buffer.subarray(0, totalBytes) };
}

// 復号器はステートレスなので 1 つを使い回す (リクエストごとに生成しない)
const UTF8_DECODER = new TextDecoder();

/**
 * 上限つきで読み取ったバイト列を UTF-8 の文字列に復号する。
 *
 * 署名検証を生バイト列で行う経路 (#290) でも、JSON パースには文字列が要る。そこだけ
 * `new TextDecoder()` を各ルートで書くと、復号の挙動 (BOM の扱い・不正バイト列の置換) が
 * ルートごとに分かれてしまい、上の `readTextWithinByteLimit` に集約した根拠が薄れる。
 * **復号は理由を問わずこの 1 箇所を通す**ため公開する (§6 DRY)。
 *
 * 復号の性質そのものは `readTextWithinByteLimit` の docstring を参照 (同じ復号器を使う)。
 * **この関数の戻り値を HMAC にかけないこと** — 理由は同じ docstring に書いてある。
 *
 * @param bytes 復号対象のバイト列 (`readBodyWithinByteLimit` が返す `bytes`)
 */
export function decodeBodyText(bytes: Uint8Array): string {
  // 共有の復号器で UTF-8 として文字列化する (不正なバイト列は U+FFFD に置換される)
  return UTF8_DECODER.decode(bytes);
}

/**
 * リクエストボディをバイト数上限つきで読み取り、UTF-8 の文字列として返す。
 *
 * **実運用で起こりうる本文については `req.text()` と結果が一致する。** どちらも同じ WHATWG の
 * UTF-8 復号を通るため、先頭 BOM の除去も、不正なバイト列が置換文字 (U+FFFD) になる挙動も
 * 同じ結果になる (BOM 無し / BOM 1 つ / 不正バイト列を含む本文で一致することを確認済み)。
 * この等価性は `req.text()` から移行した経路 (#287) が本文の解釈を変えていないことの拠り所なので、
 * 呼び出し元がそれぞれ TextDecoder を書くのではなく、根拠ごとここに 1 つだけ置く (§6 DRY)。
 *
 * **唯一の差異: BOM が 2 つ以上連続する本文。** undici の `req.text()` は BOM を自前で 1 つ
 * 剥がしてから TextDecoder に渡すため二重に剥がれ、こちらは 1 つだけ剥がす。実在の送信者が
 * こんな本文を送ることはなく、かつ**どちらの結果でも署名は不一致になる**ので、検証が緩む方向
 * (署名鍵を持たない相手の偽造が通る方向) の差ではない。この挙動は
 * `tests/request-body-limit.test.ts` で固定してある。
 *
 * **署名検証にはこの関数を使わない (#290)。** 復号は上のとおり BOM を取り除き、不正な UTF-8 を
 * 置換文字 (U+FFFD) へ潰すため、**送信者が署名したバイト列と HMAC の対象がずれる**。ずれる方向は
 * 「正規のリクエストが署名不一致として拒否される」側なので、検証が緩む差ではないが、
 * 取りこぼしは送信者側の再送が尽きると復旧できない。
 *
 * 署名検証を通る 2 経路の現状:
 *   - `inbound/line` … 自前で HMAC を計算しているので `readBodyWithinByteLimit` の生バイト列を
 *     そのまま渡し、JSON パース用の文字列だけを `decodeBodyText` で得ている (ずれは解消済み)。
 *   - `webhooks/stripe` … SDK の `constructEvent` が payload を内部で復号してから HMAC を組む
 *     ため、生バイト列を渡してもずれは残る (詳細と、それでも渡す根拠はあちらのファイル冒頭)。
 * どちらにせよ**この関数の戻り値を HMAC の入力にはしない**。
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
  // 読み取れたバイト列を UTF-8 の文字列に復号して返す (復号は decodeBodyText に一本化)
  return { ok: true, text: decodeBodyText(body.bytes) };
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
