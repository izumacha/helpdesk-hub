// JSON レスポンスを返すヘルパー
import { NextResponse } from 'next/server';
// 現在のセッション取得
import { auth } from '@/lib/auth';
// 未読件数を (キャッシュ付きで) 取得する関数
import { getUnreadNotificationCount } from '@/lib/notifications';
// SSE 購読者をプロセス内 Map に登録/解除する関数
import { addSubscriber, removeSubscriber } from '@/lib/sse-subscribers';
// Route Handler 向け共通レート制限ラッパー
import { checkRouteRateLimit } from '@/lib/route-rate-limit';

// このルートは常に動的実行 (キャッシュ無効)
export const dynamic = 'force-dynamic';
// Edge ではなく Node.js ランタイムで動かす (長時間接続のため)
export const runtime = 'nodejs';

// keep-alive ping を送る間隔 (30 秒)
const KEEPALIVE_INTERVAL_MS = 30_000;

// 監査で発見したギャップ: この SSE エンドポイントには接続確立のレート制限が無かった
// (CLAUDE.md §9 DoS/リソース枯渇防止)。新規接続確立の頻度だけを絞る (確立済みの接続は
// そのまま張り続けられ、プロセス内購読者 Map の「同時接続数そのものの上限」は別の課題として
// 残る。ここで対処するのはバグった再接続ループ・スクリプトによる新規接続の連打のみ)。
// EventSource はデフォルトで約 3 秒間隔で再接続を試みるため (下記 SSE_RETRY_MS 参照)、
// 複数タブを開く通常利用や短時間のサーバー再起動時の再接続の波を吸収できる値にする
const SSE_CONNECT_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

// SSE の retry フィールドで指定するクライアントの再接続間隔 (ミリ秒)。
// ブラウザの EventSource 既定値 (約3秒) より長くすることで、サーバー再起動やレート制限
// 超過直後の再接続の波を緩やかにし、SSE_CONNECT_RATE_LIMIT の消費ペースを落とす
const SSE_RETRY_MS = 5000;

// 文字列を SSE 用の UTF-8 バイト列に変換するエンコーダ
const encoder = new TextEncoder();

// SSE のコメント行 (":" で始まり通信維持に使う) を作る
function sseComment(text: string): Uint8Array {
  return encoder.encode(`: ${text}\n\n`);
}

// SSE の「event + data」行を作る (クライアントで addEventListener 可能)
function sseEvent(eventName: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

// SSE の retry フィールド (クライアントの次回再接続までの待ち時間指定) を作る
function sseRetry(ms: number): Uint8Array {
  return encoder.encode(`retry: ${ms}\n\n`);
}

// GET /api/notifications/stream : 未読件数更新を受け取る SSE エンドポイント
export async function GET(): Promise<Response> {
  // セッション取得
  const session = await auth();
  // 未ログイン or tenantId 不在なら 401 を返す (クライアントには JSON エラー)
  if (!session?.user?.id || !session.user.tenantId) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }
  // 購読者 ID として使うログイン中ユーザーの ID
  const userId = session.user.id;
  // 未読件数を引くテナントスコープ
  const tenantId = session.user.tenantId;

  // ユーザー単位で新規接続確立の頻度を制限する (他の Route Handler と同じ 429 契約)
  const rateLimitResponse = checkRouteRateLimit(
    `sse-connect:${userId}`,
    SSE_CONNECT_RATE_LIMIT,
    '接続が多すぎます。しばらく時間をおいて再度お試しください',
  );
  if (rateLimitResponse) return rateLimitResponse;

  // ストリーム制御用のコントローラを外側スコープで保持
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  // keep-alive 用 setInterval の参照 (cancel 時にクリア)
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  // SSE 本体となる ReadableStream を構築
  const stream = new ReadableStream<Uint8Array>({
    // ストリーム開始時に購読登録と初期送信を行う
    async start(ctrl) {
      // 外側で使えるようにコントローラを退避
      controller = ctrl;
      // このユーザー向けの購読者 Map にコントローラを登録
      addSubscriber(userId, controller);

      // クライアントの再接続間隔を指定 (ブラウザ既定の約3秒より緩やかにする)
      controller.enqueue(sseRetry(SSE_RETRY_MS));

      try {
        // 最初に現在の未読件数を取得し (tenantId スコープ)
        const initialCount = await getUnreadNotificationCount(userId, tenantId);
        // count イベントとして即時送信 (UI の初期表示用)
        controller.enqueue(sseEvent('count', { count: initialCount }));
      } catch (err) {
        // 初期カウント取得失敗はログに残す (致命的ではないので以後のブロードキャストは継続する)
        console.error('[GET /api/notifications/stream] 初期未読件数の取得に失敗しました', err);
      }

      // 30 秒ごとにコメント行を送って接続を切らせないようにする
      keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(sseComment('ping'));
        } catch (err) {
          // 送信失敗 (既に切断済み) の場合はタイマーを停止してリソースを解放する
          console.error('[GET /api/notifications/stream] keep-alive 送信失敗 (切断済み)', err);
          clearInterval(keepaliveTimer);
        }
      }, KEEPALIVE_INTERVAL_MS);
    },

    // クライアント切断時のクリーンアップ
    cancel() {
      // keep-alive タイマーを停止
      clearInterval(keepaliveTimer);
      // 購読者 Map から外す
      removeSubscriber(userId, controller);
    },
  });

  // SSE 用のヘッダを付けてストリームを返す
  return new Response(stream, {
    headers: {
      // SSE のコンテンツタイプ
      'Content-Type': 'text/event-stream',
      // 途中キャッシュを防ぐ
      'Cache-Control': 'no-cache, no-transform',
      // 長時間接続を維持
      Connection: 'keep-alive',
      // Nginx などのプロキシでバッファリングを無効化
      'X-Accel-Buffering': 'no',
    },
  });
}
