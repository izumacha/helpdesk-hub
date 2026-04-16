import type { Prisma } from '@/generated/prisma';
import type {
  AssigneeWorkloadRow,
  TicketListFilter,
  TicketRepository,
} from '@/data/ports/ticket-repository';
import { toTicket, toTicketWithRefs, toUserSummary, toComment, toHistory } from './mappers';
import type { PrismaLike } from './types';

function buildWhere(f: TicketListFilter): Prisma.TicketWhereInput {
  const where: Prisma.TicketWhereInput = {};
  if (f.creatorId !== undefined) where.creatorId = f.creatorId;
  if (f.status !== undefined) where.status = f.status;
  if (f.priority !== undefined) where.priority = f.priority;
  if (f.categoryId !== undefined) where.categoryId = f.categoryId;
  if (f.assigneeId !== undefined) {
    where.assigneeId = f.assigneeId === 'unassigned' ? null : f.assigneeId;
  }
  if (f.text) {
    const mode = f.text.caseInsensitive ? ('insensitive' as const) : undefined;
    where.OR = [
      { title: { contains: f.text.contains, mode } },
      { body: { contains: f.text.contains, mode } },
    ];
  }
  return where;
}

const REFS_INCLUDE = {
  creator: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
} as const;

export function makeTicketRepo(db: PrismaLike): TicketRepository {
  return {
    async findById(id) {
      const row = await db.ticket.findUnique({ where: { id } });
      return row ? toTicket(row) : null;
    },

    async findByIdWithRefs(id) {
      const row = await db.ticket.findUnique({ where: { id }, include: REFS_INCLUDE });
      return row ? toTicketWithRefs(row) : null;
    },

    async findByIdWithDetail(id) {
      const row = await db.ticket.findUnique({
        where: { id },
        include: {
          ...REFS_INCLUDE,
          comments: {
            orderBy: { createdAt: 'asc' },
            include: { author: { select: { id: true, name: true } } },
          },
          histories: {
            orderBy: { createdAt: 'desc' },
            include: { changedBy: { select: { id: true, name: true } } },
          },
          faqCandidate: { select: { id: true } },
        },
      });
      if (!row) return null;
      return {
        ...toTicketWithRefs(row),
        comments: row.comments.map((c) => ({
          ...toComment(c),
          author: toUserSummary(c.author),
        })),
        histories: row.histories.map((h) => ({
          ...toHistory(h),
          changedBy: toUserSummary(h.changedBy),
        })),
        faqCandidate: row.faqCandidate ? { id: row.faqCandidate.id } : null,
      };
    },

    async list({ filter, page, sort }) {
      const rows = await db.ticket.findMany({
        where: buildWhere(filter),
        orderBy: { createdAt: sort?.direction ?? 'desc' },
        skip: page.skip,
        take: page.take,
        include: REFS_INCLUDE,
      });
      return rows.map(toTicketWithRefs);
    },

    async count(filter) {
      return db.ticket.count({ where: buildWhere(filter) });
    },

    async countByStatus({ creatorId, status }) {
      return db.ticket.count({
        where: {
          status,
          ...(creatorId !== undefined ? { creatorId } : {}),
        },
      });
    },

    async countSlaOverdue(now) {
      return db.ticket.count({
        where: {
          resolutionDueAt: { lt: now },
          resolvedAt: null,
          status: { notIn: ['Resolved', 'Closed'] },
        },
      });
    },

    async workloadByAssignee({ excludeStatuses }) {
      const grouped = await db.ticket.groupBy({
        by: ['assigneeId'],
        where: { status: { notIn: excludeStatuses } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      });
      return grouped.map<AssigneeWorkloadRow>((g) => ({
        assigneeId: g.assigneeId,
        count: g._count.id,
      }));
    },

    async create(input) {
      const row = await db.ticket.create({
        data: {
          title: input.title,
          body: input.body,
          priority: input.priority,
          categoryId: input.categoryId,
          creatorId: input.creatorId,
          firstResponseDueAt: input.firstResponseDueAt ?? null,
          resolutionDueAt: input.resolutionDueAt ?? null,
        },
        include: REFS_INCLUDE,
      });
      return toTicketWithRefs(row);
    },

    async updateStatus(id, status) {
      await db.ticket.update({ where: { id }, data: { status } });
    },

    async updatePriority(id, priority) {
      await db.ticket.update({ where: { id }, data: { priority } });
    },

    async updateAssignee(id, assigneeId) {
      await db.ticket.update({ where: { id }, data: { assigneeId } });
    },

    async markEscalated(id, args) {
      await db.ticket.update({
        where: { id },
        data: {
          status: 'Escalated',
          escalatedAt: args.at,
          escalationReason: args.reason,
        },
      });
    },
  };
}
