/**
 * Post-commit notification fan-out.
 *
 * The notification *row* is expected to already have been written through the
 * repository layer (typically inside `uow.run`). This helper handles the
 * non-transactional side-effects that used to live in `createNotification`:
 * - Invalidate the cached unread count.
 * - Read the fresh count.
 * - Broadcast it over SSE.
 */

// Next.js のキャッシュタグ無効化 API
import { revalidateTag } from 'next/cache';
// リポジトリ束 (未読件数取得に使用)
import { repos } from '@/data';
// SSE の送信関数
import { broadcast } from '@/lib/sse-subscribers';

// 指定ユーザー 1 人に対して未読件数を再計算して配信する
export async function broadcastUnreadCount(userId: string): Promise<void> {
  // キャッシュされた未読件数を無効化 (次の取得で再計算させる)
  revalidateTag(`notification-count-${userId}`);
  // 最新件数を直接 DB から数える
  const count = await repos.notifications.countUnread(userId);
  // 取得した件数を SSE で即時配信
  broadcast(userId, count);
}

// 複数ユーザー向けにまとめて未読件数を再配信するヘルパー
export async function broadcastUnreadCountToMany(userIds: Iterable<string>): Promise<void> {
  // 重複 ID を除去した配列に変換 (同じユーザーに 2 度配信しないため)
  const unique = Array.from(new Set(userIds));
  // 並列に全ユーザーへ配信
  await Promise.all(unique.map(broadcastUnreadCount));
}
