// 履歴リポジトリの契約 (port) と Prisma 共通型をインポート
import type { TicketHistoryRepository } from '@/data/ports/ticket-history-repository';
import type { PrismaLike } from './types';

// Prisma クライアントを使った履歴リポジトリを生成する関数
export function makeTicketHistoryRepo(db: PrismaLike): TicketHistoryRepository {
  return {
    // 履歴を 1 件記録する (戻り値なし)
    async record(input) {
      // TicketHistory テーブルに 1 行挿入
      await db.ticketHistory.create({
        data: {
          ticketId: input.ticketId, // 対象チケット
          changedById: input.changedById, // 変更者
          field: input.field, // 変更項目
          oldValue: input.oldValue, // 変更前
          newValue: input.newValue, // 変更後
        },
      });
    },
  };
}
