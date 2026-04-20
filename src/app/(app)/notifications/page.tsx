// セッション (ログイン中ユーザー) を取得
import { auth } from '@/lib/auth';
// DB クライアント (Prisma)
import { prisma } from '@/lib/prisma';
// 「すべて既読にする」ボタン用のサーバーアクション
import { markAllRead } from '@/features/notifications/actions/notification-actions';
// 通知タイプの日本語ラベル定義
import { NOTIFICATION_TYPE_LABELS } from '@/lib/constants';

// /notifications : 自分宛の通知一覧ページ
export default async function NotificationsPage() {
  // セッション取得
  const session = await auth();
  // 未ログインなら何も描画しない (middleware が先に弾くはずの保険)
  if (!session?.user?.id) return null;

  // 自分宛の通知を最新 50 件取得 (チケットタイトル付き)
  const notifications = await prisma.notification.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { ticket: { select: { id: true, title: true } } },
  });

  return (
    <div className="space-y-4">
      {/* ヘッダー: タイトル + 一括既読ボタン */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">通知</h1>
        {/* 未読が 1 件でもあれば一括既読ボタンを表示 */}
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
        // 0 件のときは空状態のメッセージ
        <div className="rounded-lg border border-dashed border-gray-300 py-16 text-center text-gray-400">
          通知はありません
        </div>
      ) : (
        // 1 件以上ある場合は順に列挙
        <ul className="space-y-2">
          {notifications.map((n) => (
            // 未読は左ボーダー (青) で強調
            <li
              key={n.id}
              className={`rounded-lg bg-white p-4 shadow-sm ${!n.read ? 'border-l-4 border-blue-500' : ''}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  {/* 通知種別バッジ */}
                  <span className="mr-2 inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                    {NOTIFICATION_TYPE_LABELS[n.type] ?? n.type}
                  </span>
                  {/* メッセージ本文 */}
                  <span className="text-sm text-gray-800">{n.message}</span>
                  {/* 紐づくチケットがあれば詳細ページへのリンクを表示 */}
                  {n.ticket && (
                    <a
                      href={`/tickets/${n.ticket.id}`}
                      className="ml-2 text-xs text-blue-600 hover:underline"
                    >
                      チケットを見る
                    </a>
                  )}
                </div>
                {/* 受信日時 (日本語ロケール) */}
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
