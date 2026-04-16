import type {
  NotificationListItem,
  NotificationRepository,
} from '@/data/ports/notification-repository';
import type { Notification } from '@/domain/types';
import { nextId, type Store } from './store';

export function makeNotificationRepo(store: Store): NotificationRepository {
  return {
    async create(input) {
      const notification: Notification = {
        id: nextId('ntf'),
        userId: input.userId,
        ticketId: input.ticketId ?? null,
        type: input.type,
        message: input.message,
        read: false,
        createdAt: new Date(),
      };
      store.notifications.set(notification.id, notification);
      return notification;
    },

    async countUnread(userId) {
      let n = 0;
      for (const n0 of store.notifications.values()) {
        if (n0.userId === userId && !n0.read) n += 1;
      }
      return n;
    },

    async list(userId, { limit }) {
      const rows = [...store.notifications.values()]
        .filter((n) => n.userId === userId)
        .sort((a, b) => +b.createdAt - +a.createdAt)
        .slice(0, limit);
      return rows.map<NotificationListItem>((n) => {
        const ticket = n.ticketId ? (store.tickets.get(n.ticketId) ?? null) : null;
        return {
          ...n,
          ticket: ticket ? { id: ticket.id, title: ticket.title } : null,
        };
      });
    },

    async markAllRead(userId) {
      for (const [id, n] of store.notifications) {
        if (n.userId === userId && !n.read) {
          store.notifications.set(id, { ...n, read: true });
        }
      }
    },
  };
}
