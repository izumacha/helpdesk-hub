// Next.js のキャッシュ機構 (unstable_cache) を読み込む
import { unstable_cache } from 'next/cache';
// データ層の Composition Root から通知リポジトリ束を読み込む (Prisma 直叩きを避ける)
import { repos } from '@/data';

// 指定ユーザーの未読通知件数を取得する関数 (60 秒キャッシュ)
export function getUnreadNotificationCount(userId: string): Promise<number> {
  // unstable_cache で「同じタグなら 60 秒は使い回す」キャッシュ関数を生成し即呼び出す
  return unstable_cache(
    (id: string) => repos.notifications.countUnread(id), // 実際の DB カウント (port 経由)
    ['notification-count'], // キャッシュキーのプレフィックス
    { tags: [`notification-count-${userId}`], revalidate: 60 }, // 無効化用タグと再検証間隔 (秒)
  )(userId);
}
