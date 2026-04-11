import { unstable_cache, revalidateTag } from 'next/cache';
import { prisma } from '@/lib/prisma';
import type { NotificationType } from '@/generated/prisma';

export async function createNotification(
  userId: string,
  type: NotificationType,
  message: string,
  ticketId?: string,
) {
  await prisma.notification.create({
    data: { userId, type, message, ticketId },
  });
  revalidateTag(`notification-count-${userId}`);
}

export function getUnreadNotificationCount(userId: string): Promise<number> {
  return unstable_cache(
    (id: string) => prisma.notification.count({ where: { userId: id, read: false } }),
    ['notification-count'],
    { tags: [`notification-count-${userId}`], revalidate: 60 },
  )(userId);
}
