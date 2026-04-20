// Next.js のキャッシュ機構 (unstable_cache) とキャッシュ無効化関数 (revalidateTag) を読み込む
import { unstable_cache, revalidateTag } from 'next/cache';
// Prisma クライアント (DB 操作) を読み込む
import { prisma } from '@/lib/prisma';
// SSE で未読件数をリアルタイム配信するためのブロードキャスト関数を読み込む
import { broadcast } from '@/lib/sse-subscribers';
// 通知の種類 (担当割当/エスカレーション/コメント/状態変更) を表す型を読み込む
import type { NotificationType } from '@/generated/prisma';

// 通知を 1 件作成し、未読件数キャッシュの無効化 + SSE 配信まで行う関数
export async function createNotification(
  userId: string, // 通知を受け取るユーザー ID
  type: NotificationType, // 通知の種類
  message: string, // 画面に表示する文言
  ticketId?: string, // 関連チケット ID (無ければ省略可)
) {
  // 1. Notification テーブルに行を追加
  await prisma.notification.create({
    data: { userId, type, message, ticketId },
  });

  // 2. 未読件数の Next.js キャッシュを無効化 (次回取得時に再計算させる)
  revalidateTag(`notification-count-${userId}`);

  // Query live count directly (not via cache — revalidateTag just invalidated it).
  // 3. 最新の未読件数を直接 DB から取得する (キャッシュを経由しない)
  const newCount = await prisma.notification.count({ where: { userId, read: false } });
  // 4. SSE 経由で当該ユーザーへ未読件数をプッシュ配信する
  broadcast(userId, newCount);
}

// 指定ユーザーの未読通知件数を取得する関数 (60 秒キャッシュ)
export function getUnreadNotificationCount(userId: string): Promise<number> {
  // unstable_cache で「同じタグなら 60 秒は使い回す」キャッシュ関数を生成し即呼び出す
  return unstable_cache(
    (id: string) => prisma.notification.count({ where: { userId: id, read: false } }), // 実際の DB カウント
    ['notification-count'], // キャッシュキーのプレフィックス
    { tags: [`notification-count-${userId}`], revalidate: 60 }, // 無効化用タグと再検証間隔 (秒)
  )(userId);
}
