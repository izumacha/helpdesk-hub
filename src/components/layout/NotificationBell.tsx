// 未読件数を (キャッシュ付きで) 取得する関数
import { getUnreadNotificationCount } from '@/lib/notifications';
// 実際にバッジを描画する Client Component
import { NotificationBellClient } from './NotificationBellClient';

// サーバー側で初期未読件数を取得し、Client Component に渡すラッパー
// テナント越境の未読件数表示を防ぐため、userId と一緒に tenantId も親から渡してもらう
export async function NotificationBell({
  userId,
  tenantId,
}: {
  userId: string;
  tenantId: string;
}) {
  // 初回表示用の未読件数を当該テナントから取得 (Adapter 側で where に tenantId 注入)
  const initialCount = await getUnreadNotificationCount(userId, tenantId);
  // 取得した値を Client Component に渡して描画 (以後は SSE で更新)
  return <NotificationBellClient initialCount={initialCount} userId={userId} />;
}
