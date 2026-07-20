// 通知リポジトリの契約 (port)・上限クランプ定数、マッパー、Prisma 共通型をインポート
import {
  NOTIFICATION_LIST_MAX_LIMIT,
  type NotificationListItem,
  type NotificationRepository,
} from '@/data/ports/notification-repository';
import { toNotification } from './mappers';
import type { PrismaLike } from './types';

// Prisma クライアントを使った通知リポジトリを生成する関数
export function makeNotificationRepo(db: PrismaLike): NotificationRepository {
  return {
    // 通知を 1 件作成してドメイン型に変換して返す
    async create(input) {
      // 関連チケットが指定されている場合のみ、そのチケットが指定テナントに属することを検証する。
      // コメント Adapter (issue #123) と同じ fail-closed パターン: 呼び出し側が tenant スコープの
      // 取得を忘れても、他テナントのチケットに紐づく通知は作れないよう Adapter 側で拒否する。
      // (ticketId が無いチケット非関連の通知はこの検証をスキップする)
      if (input.ticketId) {
        // 親チケットをテナントスコープ付きで検索する
        const parent = await db.ticket.findFirst({
          where: { id: input.ticketId, tenantId: input.tenantId }, // チケット ID + テナントの AND 一致
          select: { id: true }, // 存在確認だけなので id のみ取得
        });
        // 親チケットが無い (= 別テナント or 不在) なら作成を拒否する
        if (!parent) {
          throw new Error('チケットが見つかりません');
        }
      }
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

    // 指定ユーザーの通知を新しい順に limit 件取得 (関連チケット付き、tenantId スコープ)。
    // 監査で発見したギャップ対応: 呼び出し側の limit をそのまま信頼せず、
    // NOTIFICATION_LIST_MAX_LIMIT を超えないようクランプする (§8 一覧取得は必ず上限を持たせる)
    async list(userId, { limit }, tenantId) {
      const rows = await db.notification.findMany({
        where: { tenantId, userId }, // テナント + ユーザーで絞る
        orderBy: { createdAt: 'desc' }, // 新しい順
        take: Math.min(limit, NOTIFICATION_LIST_MAX_LIMIT), // 件数上限 (呼び出し側の指定値をクランプ)
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
