import type { TicketHistoryRepository } from '@/data/ports/ticket-history-repository';
import type { TicketHistory } from '@/domain/types';
import { nextId, type Store } from './store';

export function makeTicketHistoryRepo(store: Store): TicketHistoryRepository {
  return {
    async record(input) {
      const row: TicketHistory = {
        id: nextId('hst'),
        ticketId: input.ticketId,
        changedById: input.changedById,
        field: input.field,
        oldValue: input.oldValue,
        newValue: input.newValue,
        createdAt: new Date(),
      };
      store.histories.set(row.id, row);
    },
  };
}
