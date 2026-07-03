// 外部 Webhook / REST API への POST を共通化するユーティリティ。
// Slack / Teams / Chatwork の各通知 Adapter が共通で使う「タイムアウト付き POST ＋
// レスポンス本文の上限読み取り」を 1 か所に集約し (DRY)、あわせて SSRF 二重防御の要である
// リダイレクト非追従をここで強制する。
//
// なぜリダイレクトを追わないか (CLAUDE.md §9「リダイレクト追跡先も同様に検証する」):
// 管理者が登録する Webhook URL は保存時・送信直前に isUnsafeUrl で「設定された URL の
// ホスト」を検証している。しかし fetch の既定 (redirect: 'follow') では、検証済みの
// パブリックホストが 30x で内部アドレス (169.254.169.254 / 10.0.0.0/8 等) へ誘導すると、
// リダイレクト先は再検証されないまま追従されてしまう。Incoming Webhook は正常時に
// リダイレクトを返さないため、リダイレクト応答は一律エラー扱いにしてこの抜け道を塞ぐ。

// Webhook レスポンスの最大読み取りサイズ (バイト数)。
// Slack は "ok" (2 バイト)、Teams は "1" 程度、Chatwork は JSON を返すがエラー確認用に 1KB で十分。
// 各 Adapter がそれぞれ定義すると不揃いになるため、ここで一元管理する (§6 定数の一元管理)。
export const DEFAULT_WEBHOOK_MAX_RESPONSE_BYTES = 1024;

// Webhook 送信のデフォルトタイムアウト (ミリ秒)。
// 相手方障害でサーバーアクションが無限にハングするのを防ぐ共通値。
// Adapter がより短い/長いタイムアウトを必要とする場合は個別に上書きできる。
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;

// Webhook POST の共通オプション
export interface WebhookPostOptions {
  // 送信ヘッダ (Content-Type や認証トークンなど)
  headers: Record<string, string>;
  // リクエストボディ (JSON 文字列やフォームエンコード済み文字列)
  body: string;
  // タイムアウト (ミリ秒)。相手側障害でサーバーアクションが無限にハングするのを防ぐ
  timeoutMs: number;
  // レスポンス本文の最大読み取りバイト数 (巨大な本文でメモリを消費しないための上限)
  maxResponseBytes: number;
}

// Webhook POST の結果。HTTP の成否と、上限付きで読み取ったレスポンス本文を返す。
// 成功条件 (Slack は本文 "ok"、Teams/Chatwork は HTTP ステータス) は呼び出し側の責務とし、
// この共通関数は「HTTP 通信」と「SSRF リダイレクト防御」だけに責務を限定する。
export interface WebhookPostResult {
  // HTTP ステータスが 2xx かどうか
  ok: boolean;
  // HTTP ステータスコード
  status: number;
  // 上限付きで読み取ったレスポンス本文
  bodyText: string;
}

// 指定 URL へ JSON/フォームボディを POST する。タイムアウト・本文上限読み取り・
// リダイレクト非追従をまとめて適用する。
export async function postWebhook(
  url: string,
  options: WebhookPostOptions,
): Promise<WebhookPostResult> {
  // 実際の HTTP リクエストを送る
  const response = await fetch(url, {
    // 通知系はすべて POST
    method: 'POST',
    // 呼び出し側が指定したヘッダをそのまま使う
    headers: options.headers,
    // 呼び出し側が組み立てたボディをそのまま送る
    body: options.body,
    // SSRF 対策: リダイレクトを自動追従しない。検証済みホストが 30x で内部アドレスへ
    // 誘導してもガードをすり抜けないようにする (CLAUDE.md §9)。
    redirect: 'manual',
    // 一定時間で打ち切る (相手側障害時のハングを防ぐ)
    signal: AbortSignal.timeout(options.timeoutMs),
  });

  // redirect: 'manual' のとき、リダイレクト応答は opaqueredirect (type='opaqueredirect',
  // status=0) になる。実装によっては 3xx をそのまま返す場合もあるため、両方を失敗扱いにする。
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    // リダイレクト先は未検証ホストへ抜ける恐れがあるため SSRF リスクとして拒否する
    throw new Error('Webhook 送信失敗: リダイレクト応答は SSRF 対策のため許可されません');
  }

  // レスポンス本文を上限バイト数まで読む (巨大な本文をそのまま保持しない §8/§9)
  const bodyText = await readBodyCapped(response, options.maxResponseBytes);

  // HTTP の成否・ステータス・本文を呼び出し側へ返す
  return { ok: response.ok, status: response.status, bodyText };
}

// レスポンス本文を上限バイト数まで読み取り、超過分は読み込まずに打ち切る内部ヘルパー。
// `response.text()` は本文全体をメモリに読み切ってから返すため、それに `.slice()` を後掛けする
// だけでは「上限バイト数」が名目上の値になり、乗っ取られた/悪意ある Webhook 先が巨大な本文を
// 送り続けた場合にサーバーのメモリを消費してしまう (§8 リソース解放 / §9 DoS 対策)。
// ここでは response.body の ReadableStream を直接読み、上限に達した時点で reader.cancel() して
// それ以降のバイト列を読まずに接続を閉じる。
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  // body ストリームを取得できない実行環境 (一部のテスト用モック等) では
  // 上限保護が効かなくなるが、素直に text() へフォールバックして機能を壊さない
  const body = response.body;
  if (!body) {
    // 全文を読んでから文字数で切り詰める (従来どおりの挙動)
    const text = await response.text();
    return text.slice(0, maxBytes);
  }

  // ストリームを 1 チャンクずつ読み取るためのリーダー
  const reader = body.getReader();
  // 受信済みチャンクを蓄えるバッファ (上限を超えたら以降は積まない)
  const chunks: Uint8Array[] = [];
  // ここまでに受信したバイト数の合計
  let received = 0;
  try {
    // ストリームが終わるか上限に達するまで読み続ける
    for (;;) {
      const { done, value } = await reader.read();
      // ストリームが正常終了したらループを抜ける
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.length;
        // 上限に達したら、残りのバイト列は読まずに接続を閉じてメモリを守る
        if (received >= maxBytes) {
          await reader.cancel().catch(() => {
            // cancel 自体の失敗は無視する (既に十分なデータは確保できている)
          });
          break;
        }
      }
    }
  } finally {
    // 例外発生時もリーダーのロックを解放してストリームを解放する
    reader.releaseLock();
  }

  // 蓄えたチャンクを 1 本の Uint8Array に連結する (上限超過分は既に読んでいないため安全なサイズ)
  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  // UTF-8 として上限バイト数までデコードする (マルチバイト文字の境界を跨ぐ可能性はあるが
  // TextDecoder は不正なバイト列を U+FFFD に置換するだけで例外にはならないため安全側に倒せる)
  const decoded = new TextDecoder().decode(combined.subarray(0, maxBytes));
  // 文字数ベースでも上限を掛けておく (呼び出し側の従来仕様と挙動を揃える)
  return decoded.slice(0, maxBytes);
}
