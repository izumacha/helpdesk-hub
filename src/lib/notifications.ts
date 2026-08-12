// Next.js のキャッシュ機構 (unstable_cache) とタグ無効化 API を読み込む
import { revalidateTag, unstable_cache } from 'next/cache';
// データ層の Composition Root から通知リポジトリ束を読み込む (Prisma 直叩きを避ける)
import { repos } from '@/data';

/**
 * 未読件数キャッシュの無効化タグを組み立てる。
 *
 * **タグ文字列の唯一の参照元** (§6 定数・キー名は単一の参照元に集約する)。
 * 以前はこのリテラルが「キャッシュを作る側」と「無効化する側」の 3 ファイルに
 * 書き写されていた。タグ名は文字列なので片方だけ変えても型検査を通ってしまい、
 * **無効化が静かに空振りして未読バッジが最大 60 秒古いまま残る**という、
 * テストでも気づきにくい壊れ方をする。組み立てをここに 1 本化して防ぐ。
 *
 * @param userId タグを引きたいユーザーの ID
 * @returns そのユーザーの未読件数キャッシュに対応するタグ文字列
 */
function unreadCountCacheTag(userId: string): string {
  // ユーザーごとに独立したタグにする (他人の未読件数まで巻き込んで無効化しないため)
  return `notification-count-${userId}`;
}

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
    // 無効化用タグ (expireUnreadCountCache と同じ組み立てを共有) と再検証間隔 (秒)
    { tags: [unreadCountCacheTag(userId)], revalidate: 60 },
  )(userId, tenantId);
}

/**
 * 指定ユーザーの未読件数キャッシュを**即時失効**させる。
 *
 * **なぜ `revalidateTag(tag, { expire: 0 })` なのか** (Next.js 16 での移行):
 *
 * - Next.js 16 で `revalidateTag` は第 2 引数 (cacheLife プロファイル) が必須になった。
 *   プロファイルを渡すと stale-while-revalidate 扱いになり、Next は
 *   「そのリクエストのパスは再検証済み」と印を付けない。つまり **Server Action が
 *   自分の書き込みを読み返せない** (read-your-own-writes が効かない)。既読化した直後に
 *   未読バッジが古い件数のまま残る、という見え方になる。
 *   `{ expire: 0 }` は Next 側の実装で「即時失効」として扱われ、印が付く
 *   (= 15 系までの引数 1 個の挙動と同じ) ので、アップグレードで挙動を変えずに済む。
 *
 * - Next.js 16 が推奨する `updateTag` は使えない。**Server Action からしか呼べず**、
 *   Route Handler から呼ぶと実行時に投げる (E872)。この関数の呼び出し元には
 *   Server Action (`update-ticket.ts`) と Route Handler (メール取り込み・コメント投稿・
 *   SLA リマインダ) の両方があるため、`updateTag` にすると **Webhook 系の経路だけが
 *   本番で落ちる**。両文脈で同じように動く `revalidateTag` に寄せる。
 *
 * @param userId キャッシュを失効させたいユーザーの ID
 */
export function expireUnreadCountCache(userId: string): void {
  // 対象ユーザーのタグを即時失効させる (次の取得で必ず DB から数え直される)
  revalidateTag(unreadCountCacheTag(userId), { expire: 0 });
}
