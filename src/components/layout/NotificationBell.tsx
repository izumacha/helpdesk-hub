import Link from 'next/link';
import { getUnreadNotificationCount } from '@/lib/notifications';

export async function NotificationBell({ userId }: { userId: string }) {
  const count = await getUnreadNotificationCount(userId);
  return (
    <Link href="/notifications" className="relative text-sm text-gray-700 hover:text-gray-900">
      通知
      {count > 0 && (
        <span className="absolute -right-2 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </Link>
  );
}
