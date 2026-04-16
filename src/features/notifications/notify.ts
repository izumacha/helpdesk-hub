/**
 * Post-commit notification fan-out.
 *
 * The notification *row* is expected to already have been written through the
 * repository layer (typically inside `uow.run`). This helper handles the
 * non-transactional side-effects that used to live in `createNotification`:
 * - Invalidate the cached unread count.
 * - Read the fresh count.
 * - Broadcast it over SSE.
 */

import { revalidateTag } from 'next/cache';
import { repos } from '@/data';
import { broadcast } from '@/lib/sse-subscribers';

export async function broadcastUnreadCount(userId: string): Promise<void> {
  revalidateTag(`notification-count-${userId}`);
  const count = await repos.notifications.countUnread(userId);
  broadcast(userId, count);
}

export async function broadcastUnreadCountToMany(userIds: Iterable<string>): Promise<void> {
  const unique = Array.from(new Set(userIds));
  await Promise.all(unique.map(broadcastUnreadCount));
}
