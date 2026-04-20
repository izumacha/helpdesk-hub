// 通知リポジトリの契約 (port) とドメイン型、ストア関連をインポート
import type {
  NotificationListItem,
  NotificationRepository,
} from '@/data/ports/notification-repository';
import type { Notification } from '@/domain/types';
import { nextId, type Store } from './store';

// メモリストアを使った通知リポジトリを生成する関数
export function makeNotificationRepo(store: Store): NotificationRepository {
  return {
    // 通知を 1 件作成してストアに登録
    async create(input) {
      // 新しい通知行を組み立てる (read は false で開始)
      const notification: Notification = {
        id: nextId(store, 'ntf'), // 'ntf_...' 形式の一意 ID
        userId: input.userId,
        ticketId: input.ticketId ?? null, // 未指定は null
        type: input.type,
        message: input.message,
        read: false,
        createdAt: new Date(),
      };
      // ストアに登録
      store.notifications.set(notification.id, notification);
      // 作成結果を返す
      return notification;
    },

    // 指定ユーザーの未読件数をカウント
    async countUnread(userId) {
      let n = 0; // カウンタ
      // 全通知を走査し、対象ユーザー & 未読のものを数える
      for (const n0 of store.notifications.values()) {
        if (n0.userId === userId && !n0.read) n += 1;
      }
      // 件数を返す
      return n;
    },

    // 指定ユーザーの通知を新しい順に limit 件取得 (関連チケット付き)
    async list(userId, { limit }) {
      const rows = [...store.notifications.values()] // 全通知を配列化
        .filter((n) => n.userId === userId) // 対象ユーザーのみ
        .sort((a, b) => +b.createdAt - +a.createdAt) // 新しい順にソート
        .slice(0, limit); // 先頭 limit 件に切る
      // 各通知に関連チケットの要約を結合して返す
      return rows.map<NotificationListItem>((n) => {
        const ticket = n.ticketId ? (store.tickets.get(n.ticketId) ?? null) : null; // 関連チケット取得
        return {
          ...n,
          ticket: ticket ? { id: ticket.id, title: ticket.title } : null,
        };
      });
    },

    // 指定ユーザーの未読通知を全て既読に更新
    async markAllRead(userId) {
      // Map の全エントリを走査
      for (const [id, n] of store.notifications) {
        // 対象ユーザーかつ未読のものだけ read: true にして書き換え
        if (n.userId === userId && !n.read) {
          store.notifications.set(id, { ...n, read: true });
        }
      }
    },
  };
}
