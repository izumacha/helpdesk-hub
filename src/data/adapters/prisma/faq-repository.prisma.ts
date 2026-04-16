import type { FaqListItem, FaqRepository } from '@/data/ports/faq-repository';
import { toFaq } from './mappers';
import type { PrismaLike } from './types';

export function makeFaqRepo(db: PrismaLike): FaqRepository {
  return {
    async findById(id) {
      const row = await db.faqCandidate.findUnique({ where: { id } });
      return row ? toFaq(row) : null;
    },

    async list() {
      const rows = await db.faqCandidate.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          ticket: { select: { id: true, title: true } },
          createdBy: { select: { name: true } },
        },
      });
      return rows.map<FaqListItem>((f) => ({
        ...toFaq(f),
        ticket: { id: f.ticket.id, title: f.ticket.title },
        createdBy: { name: f.createdBy.name },
      }));
    },

    async create(input) {
      const row = await db.faqCandidate.create({
        data: {
          ticketId: input.ticketId,
          createdById: input.createdById,
          question: input.question,
          answer: input.answer,
        },
      });
      return toFaq(row);
    },

    async updateStatus(id, status) {
      await db.faqCandidate.update({ where: { id }, data: { status } });
    },
  };
}
