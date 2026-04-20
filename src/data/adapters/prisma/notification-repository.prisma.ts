// 通知リポジトリの契約 (port)、マッパー、Prisma 共通型をインポート
import type {
  NotificationListItem,
  NotificationRepository,
} from '@/data/ports/notification-repository';
import { toNotification } from './mappers';
import type { PrismaLike } from './types';

// Prisma クライアントを使った通知リポジトリを生成する関数
export function makeNotificationRepo(db: PrismaLike): NotificationRepository {
  return {
    // 通知を 1 件作成してドメイン型に変換して返す
    async create(input) {
      const row = await db.notification.create({
        data: {
          userId: input.userId, // 受信者
          type: input.type, // 種別
          message: input.message, // 表示文言
          ticketId: input.ticketId ?? null, // 関連チケット (未指定なら null)
        },
      });
      // Prisma 行 → ドメイン型 Notification に変換
      return toNotification(row);
    },

    // 未読件数を取得 (DB 側で count)
    async countUnread(userId) {
      return db.notification.count({ where: { userId, read: false } });
    },

    // 指定ユーザーの通知を新しい順に limit 件取得 (関連チケット付き)
    async list(userId, { limit }) {
      const rows = await db.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' }, // 新しい順
        take: limit, // 件数上限
        include: { ticket: { select: { id: true, title: true } } }, // 関連チケットを JOIN
      });
      // NotificationListItem 形式に整形して返す
      return rows.map<NotificationListItem>((n) => ({
        ...toNotification(n),
        ticket: n.ticket ? { id: n.ticket.id, title: n.ticket.title } : null,
      }));
    },

    // 指定ユーザーの未読を一括で既読に更新
    async markAllRead(userId) {
      await db.notification.updateMany({ where: { userId, read: false }, data: { read: true } });
    },
  };
}
