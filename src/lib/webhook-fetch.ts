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

  // レスポンス本文を上限バイト数まで読む (巨大な本文をそのまま保持しない)
  const bodyText = await response.text().then((t) => t.slice(0, options.maxResponseBytes));

  // HTTP の成否・ステータス・本文を呼び出し側へ返す
  return { ok: response.ok, status: response.status, bodyText };
}
