import type { TicketCommentRepository } from '@/data/ports/ticket-comment-repository';
import { toComment } from './mappers';
import type { PrismaLike } from './types';

export function makeTicketCommentRepo(db: PrismaLike): TicketCommentRepository {
  return {
    async create(input) {
      const row = await db.ticketComment.create({
        data: {
          ticketId: input.ticketId,
          authorId: input.authorId,
          body: input.body,
        },
      });
      return toComment(row);
    },
  };
}
