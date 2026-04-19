'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rate-limit';
import { broadcast } from '@/lib/sse-subscribers';

export async function markAllRead() {
  const session = await auth();
  if (!session?.user?.id) throw new Error('Unauthorized');
  enforceRateLimit(`notifications-mark-read:${session.user.id}`, {
    limit: 10,
    windowMs: 60_000,
  });

  await prisma.notification.updateMany({
    where: { userId: session.user.id, read: false },
    data: { read: true },
  });

  revalidatePath('/notifications');
  revalidateTag(`notification-count-${session.user.id}`);
  broadcast(session.user.id, 0);
}
