// Next.js のキャッシュ機構 (unstable_cache) を読み込む
import { unstable_cache } from 'next/cache';
// データ層の Composition Root から通知リポジトリ束を読み込む (Prisma 直叩きを避ける)
import { repos } from '@/data';

// 指定ユーザー × テナントの未読通知件数を取得する関数 (60 秒キャッシュ)
// 未読件数はテナント単位でも区切られる (ユーザーは単一テナントだが、Adapter 側の where 句に
// tenantId 注入を強制するため引数として伝搬させる)
export function getUnreadNotificationCount(userId: string, tenantId: string): Promise<number> {
  // unstable_cache で「同じタグなら 60 秒は使い回す」キャッシュ関数を生成し即呼び出す
  return unstable_cache(
    // 実際の DB カウント (port 経由、tenantId スコープ)
    (id: string, tid: string) => repos.notifications.countUnread(id, tid),
    // キャッシュキーのプレフィックス
    ['notification-count'],
    // 無効化用タグ (markAllRead / broadcast 側でも同じタグを使用) と再検証間隔 (秒)
    { tags: [`notification-count-${userId}`], revalidate: 60 },
  )(userId, tenantId);
}
