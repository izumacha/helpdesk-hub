import type { TicketComment } from '@/domain/types';

export interface CreateCommentInput {
  ticketId: string;
  authorId: string;
  body: string;
}

export interface TicketCommentRepository {
  create(input: CreateCommentInput): Promise<TicketComment>;
}
