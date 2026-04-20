'use server';

// Next.js のキャッシュ無効化 API (ページ単位とタグ単位)
import { revalidatePath, revalidateTag } from 'next/cache';
// 現在のセッション取得
import { auth } from '@/lib/auth';
// DB 操作クライアント
import { prisma } from '@/lib/prisma';
// レート制限 (連打防止)
import { enforceRateLimit } from '@/lib/rate-limit';
// SSE で未読件数を即時ブロードキャストする関数
import { broadcast } from '@/lib/sse-subscribers';

// ログイン中ユーザーの未読通知を一括で既読にするサーバーアクション
export async function markAllRead() {
  // セッション取得
  const session = await auth();
  // 未ログインなら拒否
  if (!session?.user?.id) throw new Error('Unauthorized');
  // 60 秒あたり最大 10 回までに制限
  enforceRateLimit(`notifications-mark-read:${session.user.id}`, {
    limit: 10,
    windowMs: 60_000,
  });

  // 本人の未読通知を全て既読に更新
  await prisma.notification.updateMany({
    where: { userId: session.user.id, read: false },
    data: { read: true },
  });

  // 通知一覧ページのキャッシュを無効化
  revalidatePath('/notifications');
  // 未読件数キャッシュ (unstable_cache) を無効化
  revalidateTag(`notification-count-${session.user.id}`);
  // 即時反映のため、未読 0 を SSE で配信
  broadcast(session.user.id, 0);
}
