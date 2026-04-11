import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { markAllRead } from '@/features/notifications/actions/notification-actions';
import { NOTIFICATION_TYPE_LABELS } from '@/lib/constants';

export default async function NotificationsPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const notifications = await prisma.notification.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { ticket: { select: { id: true, title: true } } },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">通知</h1>
        {notifications.some((n) => !n.read) && (
          <form action={markAllRead}>
            <button
              type="submit"
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
            >
              すべて既読にする
            </button>
          </form>
        )}
      </div>

      {notifications.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 py-16 text-center text-gray-400">
          通知はありません
        </div>
      ) : (
        <ul className="space-y-2">
          {notifications.map((n) => (
            <li
              key={n.id}
              className={`rounded-lg bg-white p-4 shadow-sm ${!n.read ? 'border-l-4 border-blue-500' : ''}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="mr-2 inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                    {NOTIFICATION_TYPE_LABELS[n.type] ?? n.type}
                  </span>
                  <span className="text-sm text-gray-800">{n.message}</span>
                  {n.ticket && (
                    <a
                      href={`/tickets/${n.ticket.id}`}
                      className="ml-2 text-xs text-blue-600 hover:underline"
                    >
                      チケットを見る
                    </a>
                  )}
                </div>
                <span className="shrink-0 text-xs text-gray-400">
                  {n.createdAt.toLocaleString('ja-JP')}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
