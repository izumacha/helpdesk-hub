import type {
  Ticket,
  TicketComment,
  TicketHistory,
  TicketWithRefs,
  UserSummary,
} from '@/domain/types';
import type {
  AssigneeWorkloadRow,
  TicketDetail,
  TicketListFilter,
  TicketRepository,
} from '@/data/ports/ticket-repository';
import { nextId, type Store } from './store';

function userSummary(store: Store, id: string | null): UserSummary | null {
  if (!id) return null;
  const u = store.users.get(id);
  return u ? { id: u.id, name: u.name } : null;
}

function attachRefs(ticket: Ticket, store: Store): TicketWithRefs {
  const creator = userSummary(store, ticket.creatorId);
  if (!creator) {
    throw new Error(`memory adapter: creator ${ticket.creatorId} missing for ticket ${ticket.id}`);
  }
  const category = ticket.categoryId ? (store.categories.get(ticket.categoryId) ?? null) : null;
  return {
    ...ticket,
    creator,
    assignee: userSummary(store, ticket.assigneeId),
    category: category ? { id: category.id, name: category.name } : null,
  };
}

function matchesFilter(t: Ticket, filter: TicketListFilter): boolean {
  if (filter.creatorId !== undefined && t.creatorId !== filter.creatorId) return false;
  if (filter.status !== undefined && t.status !== filter.status) return false;
  if (filter.priority !== undefined && t.priority !== filter.priority) return false;
  if (filter.categoryId !== undefined && t.categoryId !== filter.categoryId) return false;
  if (filter.assigneeId !== undefined) {
    const target = filter.assigneeId === 'unassigned' ? null : filter.assigneeId;
    if (t.assigneeId !== target) return false;
  }
  if (filter.text) {
    const needle = filter.text.caseInsensitive
      ? filter.text.contains.toLowerCase()
      : filter.text.contains;
    const match = (s: string) => {
      const haystack = filter.text!.caseInsensitive ? s.toLowerCase() : s;
      return haystack.includes(needle);
    };
    if (!match(t.title) && !match(t.body)) return false;
  }
  return true;
}

export function makeTicketRepo(store: Store): TicketRepository {
  return {
    async findById(id) {
      const t = store.tickets.get(id);
      return t ? { ...t } : null;
    },

    async findByIdWithRefs(id) {
      const t = store.tickets.get(id);
      return t ? attachRefs(t, store) : null;
    },

    async findByIdWithDetail(id) {
      const t = store.tickets.get(id);
      if (!t) return null;
      const withRefs = attachRefs(t, store);

      const comments = [...store.comments.values()]
        .filter((c) => c.ticketId === id)
        .sort((a, b) => +a.createdAt - +b.createdAt)
        .map((c: TicketComment) => {
          const author = userSummary(store, c.authorId);
          if (!author) throw new Error(`memory adapter: author ${c.authorId} missing`);
          return { ...c, author };
        });

      const histories = [...store.histories.values()]
        .filter((h) => h.ticketId === id)
        .sort((a, b) => +b.createdAt - +a.createdAt)
        .map((h: TicketHistory) => {
          const changedBy = userSummary(store, h.changedById);
          if (!changedBy) throw new Error(`memory adapter: changedBy ${h.changedById} missing`);
          return { ...h, changedBy };
        });

      const faqRow = [...store.faq.values()].find((f) => f.ticketId === id) ?? null;

      const detail: TicketDetail = {
        ...withRefs,
        comments,
        histories,
        faqCandidate: faqRow ? { id: faqRow.id } : null,
      };
      return detail;
    },

    async list({ filter, page, sort }) {
      let rows = [...store.tickets.values()].filter((t) => matchesFilter(t, filter));
      const direction = sort?.direction ?? 'desc';
      rows.sort((a, b) =>
        direction === 'asc' ? +a.createdAt - +b.createdAt : +b.createdAt - +a.createdAt,
      );
      rows = rows.slice(page.skip, page.skip + page.take);
      return rows.map((t) => attachRefs(t, store));
    },

    async count(filter) {
      let n = 0;
      for (const t of store.tickets.values()) {
        if (matchesFilter(t, filter)) n += 1;
      }
      return n;
    },

    async countByStatus({ creatorId, status }) {
      let n = 0;
      for (const t of store.tickets.values()) {
        if (t.status !== status) continue;
        if (creatorId !== undefined && t.creatorId !== creatorId) continue;
        n += 1;
      }
      return n;
    },

    async countSlaOverdue(now) {
      let n = 0;
      for (const t of store.tickets.values()) {
        if (!t.resolutionDueAt) continue;
        if (t.resolutionDueAt >= now) continue;
        if (t.resolvedAt !== null) continue;
        if (t.status === 'Resolved' || t.status === 'Closed') continue;
        n += 1;
      }
      return n;
    },

    async workloadByAssignee({ excludeStatuses }) {
      const counts = new Map<string | null, number>();
      for (const t of store.tickets.values()) {
        if (excludeStatuses.includes(t.status)) continue;
        counts.set(t.assigneeId, (counts.get(t.assigneeId) ?? 0) + 1);
      }
      const rows: AssigneeWorkloadRow[] = [...counts.entries()].map(([assigneeId, count]) => ({
        assigneeId,
        count,
      }));
      rows.sort((a, b) => b.count - a.count);
      return rows;
    },

    async create(input) {
      const now = new Date();
      const ticket: Ticket = {
        id: nextId('tkt'),
        title: input.title,
        body: input.body,
        status: 'New',
        priority: input.priority,
        createdAt: now,
        updatedAt: now,
        firstResponseDueAt: input.firstResponseDueAt ?? null,
        resolutionDueAt: input.resolutionDueAt ?? null,
        firstRespondedAt: null,
        resolvedAt: null,
        escalatedAt: null,
        escalationReason: null,
        creatorId: input.creatorId,
        assigneeId: null,
        categoryId: input.categoryId,
      };
      store.tickets.set(ticket.id, ticket);
      return attachRefs(ticket, store);
    },

    async updateStatus(id, status) {
      const t = store.tickets.get(id);
      if (!t) throw new Error(`ticket not found: ${id}`);
      store.tickets.set(id, { ...t, status, updatedAt: new Date() });
    },

    async updatePriority(id, priority) {
      const t = store.tickets.get(id);
      if (!t) throw new Error(`ticket not found: ${id}`);
      store.tickets.set(id, { ...t, priority, updatedAt: new Date() });
    },

    async updateAssignee(id, assigneeId) {
      const t = store.tickets.get(id);
      if (!t) throw new Error(`ticket not found: ${id}`);
      store.tickets.set(id, { ...t, assigneeId, updatedAt: new Date() });
    },

    async markEscalated(id, args) {
      const t = store.tickets.get(id);
      if (!t) throw new Error(`ticket not found: ${id}`);
      store.tickets.set(id, {
        ...t,
        status: 'Escalated',
        escalatedAt: args.at,
        escalationReason: args.reason,
        updatedAt: new Date(),
      });
    },
  };
}
