import type { FaqListItem, FaqRepository } from '@/data/ports/faq-repository';
import type { FaqCandidate } from '@/domain/types';
import { nextId, type Store } from './store';

export function makeFaqRepo(store: Store): FaqRepository {
  return {
    async findById(id) {
      return store.faq.get(id) ?? null;
    },

    async list() {
      const rows = [...store.faq.values()].sort((a, b) => +b.createdAt - +a.createdAt);
      return rows.map<FaqListItem>((f) => {
        const ticket = store.tickets.get(f.ticketId);
        const createdBy = store.users.get(f.createdById);
        if (!ticket) throw new Error(`memory adapter: ticket ${f.ticketId} missing`);
        if (!createdBy) throw new Error(`memory adapter: user ${f.createdById} missing`);
        return {
          ...f,
          ticket: { id: ticket.id, title: ticket.title },
          createdBy: { name: createdBy.name },
        };
      });
    },

    async create(input) {
      const now = new Date();
      const row: FaqCandidate = {
        id: nextId('faq'),
        ticketId: input.ticketId,
        createdById: input.createdById,
        question: input.question,
        answer: input.answer,
        status: 'Candidate',
        createdAt: now,
        updatedAt: now,
      };
      store.faq.set(row.id, row);
      return row;
    },

    async updateStatus(id, status) {
      const row = store.faq.get(id);
      if (!row) throw new Error(`faq candidate not found: ${id}`);
      store.faq.set(id, { ...row, status, updatedAt: new Date() });
    },
  };
}
