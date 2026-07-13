// LINE Messaging API のコンテンツ取得 (画像添付ダウンロード) 専用ヘルパー。
//
// docs/smb-dx-pivot-plan.md §1.2 ペルソナ「現場リーダー」の最優先ユースケース「写真を撮って
// 送るだけで終わってほしい」は、メール取り込み (PR #207) で実現済みだが、このペルソナが実際に
// 最も使う LINE 経由では実現できていなかった (監査で発見したギャップ)。LINE の画像メッセージは
// 本文にバイト列を含まず、別途 Messaging API の Content エンドポイントから取得する必要がある。
//
// なぜ webhook-fetch.ts (postWebhook) を再利用しないか:
// postWebhook は「POST・テキストレスポンス」専用 (Slack/Teams/Chatwork の通知送信向け) だが、
// ここでは「GET・バイナリレスポンス (画像本体)」が必要なため別モジュールに分離する。
// ただし「タイムアウト」「レスポンスサイズの上限読み取り (§8/§9 DoS 対策)」
// 「SSRF 対策 (undici + Dispatcher でリダイレクト非追従・DNS リバインディング対策)」という
// 設計方針は webhook-fetch.ts と揃える。

// SSRF 対策済みの undici fetch (Dispatcher を差し込める版。webhook-fetch.ts と同じ理由で使う)
import { fetch as undiciFetch } from 'undici';
// 接続直前に解決済み IP を検証する Dispatcher (DNS リバインディング対策)
import { ssrfSafeDispatcher } from '@/lib/ssrf-guard';
// 添付ファイルのサイズ上限 (Web フォーム/メール取り込みと同じ上限をここでも使う。単一の源)
import { MAX_ATTACHMENT_SIZE_BYTES } from '@/domain/attachment';

// LINE Messaging API のコンテンツ取得エンドポイント (固定ホスト。messageId は URL パスに
// 埋め込むが、LINE 側が発行する英数字 ID のみでユーザー入力ではないため SSRF の懸念はない)
const LINE_CONTENT_API_BASE = 'https://api-data.line.me/v2/bot/message';

// コンテンツ取得のタイムアウト (ミリ秒)。画像は line-push.ts の push (5秒) より大きいため少し長めにする
const LINE_CONTENT_FETCH_TIMEOUT_MS = 10_000;

// 読み取りバイト数の上限。readBodyCappedBytes は「受信済みバイト数が上限を超えたか
// (received > maxBytes)」で打ち切るため、上限ちょうどのファイルは超過にならず最後まで読み切れ、
// 1 バイトでも超えた時点で打ち切られる。この比較だけで境界値を正しく扱えるため、上限値自体に
// +1 等の調整は不要 (以前は +1 していたが、received > (MAX+1) という比較になり実質 MAX+2 バイト
// まで許してしまう off-by-one だった)
const READ_CAP_BYTES = MAX_ATTACHMENT_SIZE_BYTES;

// 取得できたコンテンツ (バイト列 + LINE サーバが返す実際の Content-Type)
export interface LineMessageContent {
  bytes: Uint8Array; // ファイル本体のバイト列
  contentType: string; // LINE サーバが返す実際の Content-Type (申告ではなく実測値)
}

// 指定した LINE メッセージ ID の添付コンテンツ (画像等) を取得する。
// 取得に失敗した場合 (HTTP エラー・タイムアウト・サイズ超過・リダイレクト等) は null を返し、
// 呼び出し側は「添付なしで起票を継続する」フォールバックを行う (§9 fail-safe: 添付取得の
// 失敗だけでチケット本文自体の取り込みを止めない。メール取り込みの検証失敗時と同じ方針)。
export async function fetchLineMessageContent(
  accessToken: string,
  messageId: string,
): Promise<LineMessageContent | null> {
  // /code-review ultra 指摘対応 (2026-07-13): 以前は fetch 呼び出しだけを try/catch していたため、
  // ヘッダ受信後にボディのストリーム読み取り中 (readBodyCappedBytes 内) でタイムアウト・接続断が
  // 起きると例外が捕捉されずに呼び出し元 (processLineEvent → POST) まで伝播し、この Webhook が
  // 常に 200 を返すという契約 (LINE の再送ループを止めるための前提) を破ってしまっていた。
  // fetch とボディ読み取りの両方をまとめて 1 つの try で囲み、どちらの失敗も「添付なしで
  // 起票を継続する」フォールバックに正しく合流させる。
  try {
    const response = await undiciFetch(`${LINE_CONTENT_API_BASE}/${messageId}/content`, {
      method: 'GET',
      // 長期アクセストークンを Bearer 認証で渡す (line-push.ts と同じ LINE API 仕様)
      headers: { Authorization: `Bearer ${accessToken}` },
      // SSRF 対策: リダイレクトを自動追従しない (webhook-fetch.ts と同じ方針)
      redirect: 'manual',
      // 相手側の障害で起票処理が無限にハングしないよう一定時間で打ち切る
      signal: AbortSignal.timeout(LINE_CONTENT_FETCH_TIMEOUT_MS),
      // SSRF 対策: DNS 解決した実際の接続先 IP を検証する (DNS リバインディング対策)
      dispatcher: ssrfSafeDispatcher,
    });

    // redirect: 'manual' のとき、リダイレクト応答は opaqueredirect になる (webhook-fetch.ts と同じ判定)
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      console.warn('[line-content] redirect response rejected (SSRF guard)');
      return null;
    }
    if (!response.ok) {
      console.warn(`[line-content] failed to fetch message content: HTTP ${response.status}`);
      return null;
    }

    // LINE サーバが返す実際の Content-Type (申告ベースではなく実測値なので、後段の
    // validateUploadedFilesLenient のマジックバイト検証と合わせて二重に信頼性を確認できる)
    const contentType = response.headers.get('content-type') ?? '';
    const bytes = await readBodyCappedBytes(response, READ_CAP_BYTES);
    if (bytes === null) {
      // 上限超過は「巨大すぎる添付」として添付なしにフォールバックさせる (DoS 対策 §9)
      console.warn('[line-content] message content exceeds size limit, dropping attachment');
      return null;
    }
    return { bytes, contentType };
  } catch (err) {
    // タイムアウト・DNS 失敗・接続エラー・ボディ読み取り中の切断等をまとめてログに残し、
    // 添付なしにフォールバックさせる
    console.warn('[line-content] failed to fetch message content', err);
    return null;
  }
}

// undici の Response 型と lib.dom の Response 型は ReadableStream 型が微妙に非互換のため、
// readBodyCappedBytes が実際に使うメンバーだけを持つ最小限の構造型で受け取る
// (webhook-fetch.ts の FetchLikeResponse と同じ考え方)
interface FetchLikeResponse {
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
      releaseLock(): void;
    };
  } | null;
}

// レスポンス本文を上限バイト数まで読み取り、超過したら null を返す (呼び出し側がフォールバックする)。
// webhook-fetch.ts の readBodyCapped と似た構造だが、あちらは文字列 (通知レスポンス確認用) を
// 返す用途のため、画像本体のバイト列をそのまま返すこちらとは戻り値の型が異なり共通化しなかった。
async function readBodyCappedBytes(
  response: FetchLikeResponse,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const body = response.body;
  if (!body) return null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.length;
        if (received > maxBytes) {
          // 上限を超えた時点で以降のバイト列は読まずに接続を閉じる (メモリ保護 §8/§9)
          await reader.cancel().catch(() => {
            // cancel 自体の失敗は無視する (既に「超過」の判定は確定している)
          });
          return null;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}
