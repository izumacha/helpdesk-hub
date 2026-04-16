import type { TicketHistoryRepository } from '@/data/ports/ticket-history-repository';
import type { PrismaLike } from './types';

export function makeTicketHistoryRepo(db: PrismaLike): TicketHistoryRepository {
  return {
    async record(input) {
      await db.ticketHistory.create({
        data: {
          ticketId: input.ticketId,
          changedById: input.changedById,
          field: input.field,
          oldValue: input.oldValue,
          newValue: input.newValue,
        },
      });
    },
  };
}
