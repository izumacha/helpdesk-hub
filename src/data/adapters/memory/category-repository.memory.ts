import type { CategoryRepository } from '@/data/ports/category-repository';
import type { Store } from './store';

export function makeCategoryRepo(store: Store): CategoryRepository {
  return {
    async list() {
      return [...store.categories.values()]
        .map((c) => ({ id: c.id, name: c.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async findById(id) {
      const row = store.categories.get(id);
      return row ? { id: row.id, name: row.name } : null;
    },
  };
}
