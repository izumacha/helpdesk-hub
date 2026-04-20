// 未読件数を (キャッシュ付きで) 取得する関数
import { getUnreadNotificationCount } from '@/lib/notifications';
// 実際にバッジを描画する Client Component
import { NotificationBellClient } from './NotificationBellClient';

// サーバー側で初期未読件数を取得し、Client Component に渡すラッパー
export async function NotificationBell({ userId }: { userId: string }) {
  // 初回表示用の未読件数を DB から取得
  const initialCount = await getUnreadNotificationCount(userId);
  // 取得した値を Client Component に渡して描画 (以後は SSE で更新)
  return <NotificationBellClient initialCount={initialCount} userId={userId} />;
}
