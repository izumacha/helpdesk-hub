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
}
