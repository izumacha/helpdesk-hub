// セッション (ログイン中ユーザー) を取得
import { auth } from '@/lib/auth';
// DB クライアント (Prisma)
import { prisma } from '@/lib/prisma';
// 「すべて既読にする」ボタン用のサーバーアクション
import { markAllRead } from '@/features/notifications/actions/notification-actions';
// 通知タイプの日本語ラベル定義
import { NOTIFICATION_TYPE_LABELS } from '@/lib/constants';
// 日本時間 (Asia/Tokyo) で日時を文字列化するユーティリティ
import { formatDateTimeJP } from '@/lib/format-date';

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

  // 未読が 1 件でもあるかどうか (ボタン表示判定に使用)
  const hasUnread = notifications.some((n) => !n.read);

  return (
    <div className="space-y-6">
      {/* ヘッダー: タイトル + サブテキスト + 一括既読ボタン */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">通知</h1>
          <p className="mt-1 text-sm text-slate-500">
            担当割当・コメント・ステータス変更などの最新通知を確認できます。
          </p>
        </div>
        {/* 未読が 1 件でもあれば一括既読ボタンを表示 */}
        {hasUnread && (
          <form action={markAllRead}>
            <button
              type="submit"
              className="rounded-lg border border-teal-200 bg-white px-3.5 py-2 text-sm font-medium text-teal-700 transition hover:bg-teal-50"
            >
              すべて既読にする
            </button>
          </form>
        )}
      </div>

      {notifications.length === 0 ? (
        // 0 件のときは空状態のメッセージ
        <div className="rounded-2xl bg-white py-20 text-center text-slate-400 ring-1 ring-slate-200">
          <p className="text-sm">通知はありません</p>
        </div>
      ) : (
        // 1 件以上ある場合は順に列挙
        <ul className="space-y-2.5">
          {notifications.map((n) => (
            // 未読はティールリング + 薄いミント背景で柔らかく強調
            <li
              key={n.id}
              className={`rounded-2xl bg-white p-4 shadow-sm ring-1 transition ${
                !n.read ? 'bg-teal-50/30 ring-teal-200' : 'ring-slate-100'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-1 items-start gap-2.5">
                  {/* 未読インジケータ (小さなティールドット) ─ 既読でも位置を保つため透明配置 */}
                  <span
                    aria-hidden
                    className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${
                      !n.read ? 'bg-teal-500' : 'bg-transparent'
                    }`}
                  />
                  <div className="flex-1">
                    {/* 通知種別バッジ */}
                    <span className="mr-2 inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                      {NOTIFICATION_TYPE_LABELS[n.type] ?? n.type}
                    </span>
                    {/* メッセージ本文 */}
                    <span className="text-sm text-slate-800">{n.message}</span>
                    {/* 紐づくチケットがあれば詳細ページへのリンクを表示 */}
                    {n.ticket && (
                      <a
                        href={`/tickets/${n.ticket.id}`}
                        className="ml-2 text-xs text-teal-700 transition hover:text-teal-800 hover:underline"
                      >
                        チケットを見る
                      </a>
                    )}
                  </div>
                </div>
                {/* 受信日時 (日本時間で表示) */}
                <span className="shrink-0 text-xs text-slate-400">
                  {/* 通知作成日時を日本時間で表示する */}
                  {formatDateTimeJP(n.createdAt)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
