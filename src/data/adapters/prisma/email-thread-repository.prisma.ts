// メールスレッド対応表リポジトリの契約 (port) と Prisma 共通型をインポート
import type { EmailThreadRepository } from '@/data/ports/email-thread-repository';
import type { PrismaLike } from './types';

// Prisma クライアントを使った EmailThreadRef リポジトリを生成する関数
export function makeEmailThreadRepo(db: PrismaLike): EmailThreadRepository {
  return {
    // 参照 Message-ID 群から、紐づく既存チケット ID を 1 件返す (tenantId スコープ)
    async findTicketIdByMessageIds(messageIds, tenantId) {
      // 参照が無ければ突き合わせ不要 (新規起票へ倒す)
      if (messageIds.length === 0) return null;
      // tenantId + messageId IN (...) で対応表を引く。複数ヒット時は新しい登録を優先する
      const row = await db.emailThreadRef.findFirst({
        where: { tenantId, messageId: { in: messageIds } }, // 必ず tenantId でスコープ (クロステナント遮断 §9)
        select: { ticketId: true }, // 逆引きに必要なのは ticketId のみ
        orderBy: { createdAt: 'desc' }, // 直近に紐づけた対応を優先
      });
      // 見つかれば ticketId、無ければ null
      return row?.ticketId ?? null;
    },

    // Message-ID とチケットの対応を 1 件登録する (冪等)
    async register(input) {
      // createMany + skipDuplicates で「既に同じ (tenantId, messageId) があれば無視」する。
      // Webhook の再送 (at-least-once) でも二重登録にならず、例外も投げない。
      await db.emailThreadRef.createMany({
        data: [
          {
            messageId: input.messageId, // 正規化済み Message-ID
            ticketId: input.ticketId, // 紐づくチケット
            tenantId: input.tenantId, // 所属テナント (where スコープのキー)
          },
        ],
        skipDuplicates: true, // (tenantId, messageId) のユニーク衝突は無視する
      });
    },
  };
}
