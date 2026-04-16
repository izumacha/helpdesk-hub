import type { Notification, NotificationType } from '@/domain/types';

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  message: string;
  ticketId?: string | null;
}

export interface NotificationListItem extends Notification {
  ticket: { id: string; title: string } | null;
}

export interface NotificationRepository {
  create(input: CreateNotificationInput): Promise<Notification>;
  countUnread(userId: string): Promise<number>;
  list(userId: string, opts: { limit: number }): Promise<NotificationListItem[]>;
  markAllRead(userId: string): Promise<void>;
}
