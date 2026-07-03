// LINE メッセージ対応表リポジトリの契約 (port) と Prisma 共通型をインポート
import type { LineMessageRepository } from '@/data/ports/line-message-repository';
import type { PrismaLike } from './types';

// Prisma クライアントを使った LineMessageRef リポジトリを生成する関数
export function makeLineMessageRepo(db: PrismaLike): LineMessageRepository {
  return {
    // この LINE メッセージ ID が既に取り込み済みなら、紐づくチケット ID を返す (tenantId スコープ)
    async findTicketIdByMessageId(lineMessageId, tenantId) {
      // tenantId + lineMessageId の一意キーで対応表を引く (必ず tenantId でスコープ §9)
      const row = await db.lineMessageRef.findUnique({
        where: { tenantId_lineMessageId: { tenantId, lineMessageId } },
        select: { ticketId: true }, // 逆引きに必要なのは ticketId のみ
      });
      // 見つかれば ticketId、無ければ null
      return row?.ticketId ?? null;
    },

    // LINE メッセージ ID とチケットの対応を 1 件登録する (冪等)
    async register(input) {
      // createMany + skipDuplicates で「既に同じ (tenantId, lineMessageId) があれば無視」する。
      // Webhook の再送 (at-least-once) でも二重登録にならず、例外も投げない。
      await db.lineMessageRef.createMany({
        data: [
          {
            lineMessageId: input.lineMessageId, // LINE メッセージ ID
            ticketId: input.ticketId, // 紐づくチケット
            tenantId: input.tenantId, // 所属テナント (where スコープのキー)
          },
        ],
        skipDuplicates: true, // (tenantId, lineMessageId) のユニーク衝突は無視する
      });
    },
  };
}
