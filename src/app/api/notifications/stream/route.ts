// JSON レスポンスを返すヘルパー
import { NextResponse } from 'next/server';
// 現在のセッション取得
import { auth } from '@/lib/auth';
// 未読件数を (キャッシュ付きで) 取得する関数
import { getUnreadNotificationCount } from '@/lib/notifications';
// SSE 購読者をプロセス内 Map に登録/解除する関数
import { addSubscriber, removeSubscriber } from '@/lib/sse-subscribers';

// このルートは常に動的実行 (キャッシュ無効)
export const dynamic = 'force-dynamic';
// Edge ではなく Node.js ランタイムで動かす (長時間接続のため)
export const runtime = 'nodejs';

// keep-alive ping を送る間隔 (30 秒)
const KEEPALIVE_INTERVAL_MS = 30_000;

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

// GET /api/notifications/stream : 未読件数更新を受け取る SSE エンドポイント
export async function GET(): Promise<Response> {
  // セッション取得
  const session = await auth();
  // 未ログインなら 401 を返す (クライアントには JSON エラー)
  if (!session?.user?.id) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }
  // 購読者 ID として使うログイン中ユーザーの ID
  const userId = session.user.id;

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

      try {
        // 最初に現在の未読件数を取得し
        const initialCount = await getUnreadNotificationCount(userId);
        // count イベントとして即時送信 (UI の初期表示用)
        controller.enqueue(sseEvent('count', { count: initialCount }));
      } catch {
        // 致命的ではないので握りつぶす (以後のブロードキャストは届く)
      }

      // 30 秒ごとにコメント行を送って接続を切らせないようにする
      keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(sseComment('ping'));
        } catch {
          // 送信失敗 (既に切断) ならタイマー停止
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
