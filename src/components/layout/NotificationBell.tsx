import { getUnreadNotificationCount } from '@/lib/notifications';
import { NotificationBellClient } from './NotificationBellClient';

export async function NotificationBell({ userId }: { userId: string }) {
  const initialCount = await getUnreadNotificationCount(userId);
  return <NotificationBellClient initialCount={initialCount} userId={userId} />;
}
