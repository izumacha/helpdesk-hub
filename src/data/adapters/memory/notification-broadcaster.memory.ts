// 通知ブロードキャスタのポート型とコントローラー型をインポート
import type {
  BroadcastController,
  NotificationBroadcaster,
} from '@/data/ports/notification-broadcaster';

/**
 * In-process Map implementation of `NotificationBroadcaster`.
 *
 * Safe for single-process deployments (standalone Docker) only. Each user maps
 * to a Set of `ReadableStreamDefaultController` instances — one per open
 * browser tab / EventSource connection.
 *
 * Horizontal scaling caveat: when running behind a load balancer with multiple
 * app instances, a `broadcast` call produced on instance B will not reach a
 * user whose EventSource is attached to instance A — the unread count will
 * silently drift until the next cache revalidation. Swap this adapter for a
 * Redis/Postgres-backed one to fix that.
 */
// プロセス内 Map を使った NotificationBroadcaster 実装を生成する関数
export function createInMemoryNotificationBroadcaster(): NotificationBroadcaster {
  // ユーザー ID → そのユーザーの全 SSE 接続 (Set) のマップ
  const subscribers = new Map<string, Set<BroadcastController>>();

  // SSE メッセージ文字列をバイト列にエンコードするヘルパー (event: count 形式)
  const encodeCount = (count: number): Uint8Array =>
    new TextEncoder().encode(`event: count\ndata: ${JSON.stringify({ count })}\n\n`);

  return {
    // 新しい購読 (SSE 接続) を登録
    addSubscriber(userId, controller) {
      // 既存の Set を取得 (まだ無ければ新規作成)
      let controllers = subscribers.get(userId);
      if (!controllers) {
        controllers = new Set();
        subscribers.set(userId, controllers);
      }
      // コントローラーを Set に追加
      controllers.add(controller);
    },

    // 購読 (SSE 接続) を解除
    removeSubscriber(userId, controller) {
      const controllers = subscribers.get(userId); // 該当ユーザーの Set を取得
      if (!controllers) return; // 未登録なら何もしない
      controllers.delete(controller); // 対象の接続を削除
      // Set が空になったらユーザーキーごとマップから削除
      if (controllers.size === 0) {
        subscribers.delete(userId);
      }
    },

    // 指定ユーザーの全接続に未読件数を送信
    broadcast(userId, count) {
      const controllers = subscribers.get(userId); // 該当ユーザーの接続集合
      if (!controllers || controllers.size === 0) return; // 接続なしなら終了

      // 送信メッセージを事前エンコード (全接続で使い回す)
      const message = encodeCount(count);
      // 各接続に送る。書き込みに失敗した接続は Set から除外する
      for (const controller of controllers) {
        try {
          controller.enqueue(message);
        } catch {
          controllers.delete(controller);
        }
      }

      // 全接続が切れていた場合はユーザーキーごとマップから削除
      if (controllers.size === 0) {
        subscribers.delete(userId);
      }
    },
  };
}
