// 通知リポジトリの契約 (port)、マッパー、Prisma 共通型をインポート
import type {
  NotificationListItem,
  NotificationRepository,
} from '@/data/ports/notification-repository';
import { toNotification } from './mappers';
import type { PrismaLike } from './types';

// Prisma クライアントを使った通知リポジトリを生成する関数
export function makeNotificationRepo(db: PrismaLike): NotificationRepository {
  return {
    // 通知を 1 件作成してドメイン型に変換して返す
    async create(input) {
      const row = await db.notification.create({
        data: {
          userId: input.userId, // 受信者
          type: input.type, // 種別
          message: input.message, // 表示文言
          ticketId: input.ticketId ?? null, // 関連チケット (未指定なら null)
          tenantId: input.tenantId, // 所属テナントを必ず保存
        },
      });
      // Prisma 行 → ドメイン型 Notification に変換
      return toNotification(row);
    },

    // 未読件数を取得 (DB 側で count、tenantId スコープ)
    async countUnread(userId, tenantId) {
      return db.notification.count({ where: { tenantId, userId, read: false } });
    },

    // 指定ユーザーの通知を新しい順に limit 件取得 (関連チケット付き、tenantId スコープ)
    async list(userId, { limit }, tenantId) {
      const rows = await db.notification.findMany({
        where: { tenantId, userId }, // テナント + ユーザーで絞る
        orderBy: { createdAt: 'desc' }, // 新しい順
        take: limit, // 件数上限
        include: { ticket: { select: { id: true, title: true } } }, // 関連チケットを JOIN
      });
      // NotificationListItem 形式に整形して返す
      return rows.map<NotificationListItem>((n) => ({
        ...toNotification(n),
        ticket: n.ticket ? { id: n.ticket.id, title: n.ticket.title } : null,
      }));
    },

    // 指定ユーザーの未読を一括で既読に更新 (tenantId を必ず where に含めてクロステナント既読化を防ぐ)
    async markAllRead(userId, tenantId) {
      // userId + tenantId + 未読 の 3 条件に一致する行だけを read: true に更新する
      await db.notification.updateMany({
        where: { userId, tenantId, read: false }, // テナントを跨いだ既読化を防ぐためテナントも条件に入れる
        data: { read: true }, // 既読フラグを立てる
      });
    },
  };
}
