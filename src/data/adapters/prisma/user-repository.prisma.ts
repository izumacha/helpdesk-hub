import type { UserRepository } from '@/data/ports/user-repository';
import { toUser, toUserSummary } from './mappers';
import type { PrismaLike } from './types';

export function makeUserRepo(db: PrismaLike): UserRepository {
  return {
    async findById(id) {
      const row = await db.user.findUnique({ where: { id } });
      return row ? toUser(row) : null;
    },

    async findByEmail(email) {
      const row = await db.user.findUnique({ where: { email } });
      return row ? toUser(row) : null;
    },

    async listAgents() {
      const rows = await db.user.findMany({
        where: { role: { in: ['agent', 'admin'] } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      return rows.map(toUserSummary);
    },

    async listAgentIds() {
      const rows = await db.user.findMany({
        where: { role: { in: ['agent', 'admin'] } },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },

    async findSummariesByIds(ids) {
      if (ids.length === 0) return [];
      const rows = await db.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      });
      return rows.map(toUserSummary);
    },
  };
}
