import type { CategoryRepository } from '@/data/ports/category-repository';
import type { PrismaLike } from './types';

export function makeCategoryRepo(db: PrismaLike): CategoryRepository {
  return {
    async list() {
      const rows = await db.category.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      });
      return rows;
    },
    async findById(id) {
      const row = await db.category.findUnique({
        where: { id },
        select: { id: true, name: true },
      });
      return row;
    },
  };
}
