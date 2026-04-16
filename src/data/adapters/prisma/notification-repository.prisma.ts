import type {
  NotificationListItem,
  NotificationRepository,
} from '@/data/ports/notification-repository';
import { toNotification } from './mappers';
import type { PrismaLike } from './types';

export function makeNotificationRepo(db: PrismaLike): NotificationRepository {
  return {
    async create(input) {
      const row = await db.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          message: input.message,
          ticketId: input.ticketId ?? null,
        },
      });
      return toNotification(row);
    },

    async countUnread(userId) {
      return db.notification.count({ where: { userId, read: false } });
    },

    async list(userId, { limit }) {
      const rows = await db.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: { ticket: { select: { id: true, title: true } } },
      });
      return rows.map<NotificationListItem>((n) => ({
        ...toNotification(n),
        ticket: n.ticket ? { id: n.ticket.id, title: n.ticket.title } : null,
      }));
    },

    async markAllRead(userId) {
      await db.notification.updateMany({ where: { userId, read: false }, data: { read: true } });
    },
  };
}
