import type { TicketCommentRepository } from '@/data/ports/ticket-comment-repository';
import type { TicketComment } from '@/domain/types';
import { nextId, type Store } from './store';

export function makeTicketCommentRepo(store: Store): TicketCommentRepository {
  return {
    async create(input) {
      const row: TicketComment = {
        id: nextId(store, 'cmt'),
        ticketId: input.ticketId,
        authorId: input.authorId,
        body: input.body,
        createdAt: new Date(),
      };
      store.comments.set(row.id, row);
      return row;
    },
  };
}
