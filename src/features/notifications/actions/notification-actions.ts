'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function markAllRead() {
  const session = await auth();
  if (!session?.user?.id) throw new Error('Unauthorized');

  await prisma.notification.updateMany({
    where: { userId: session.user.id, read: false },
    data: { read: true },
  });
  revalidatePath('/notifications');
  revalidateTag(`notification-count-${session.user.id}`);
}
