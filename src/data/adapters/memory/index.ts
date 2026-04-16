import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
import { makeCategoryRepo } from './category-repository.memory';
import { makeFaqRepo } from './faq-repository.memory';
import { makeNotificationRepo } from './notification-repository.memory';
import { cloneStore, createEmptyStore, overwriteStore, type Store } from './store';
import { makeTicketCommentRepo } from './ticket-comment-repository.memory';
import { makeTicketHistoryRepo } from './ticket-history-repository.memory';
import { makeTicketRepo } from './ticket-repository.memory';
import { makeUserRepo } from './user-repository.memory';

export type { Store } from './store';
export { createEmptyStore } from './store';

export function buildMemoryRepos(store: Store): Repos {
  return {
    tickets: makeTicketRepo(store),
    users: makeUserRepo(store),
    notifications: makeNotificationRepo(store),
    faq: makeFaqRepo(store),
    history: makeTicketHistoryRepo(store),
    comments: makeTicketCommentRepo(store),
    categories: makeCategoryRepo(store),
  };
}

/**
 * Minimal transaction implementation: snapshot store, run callback, restore on throw.
 * Matches the Prisma adapter's all-or-nothing semantics — good enough for unit tests.
 */
export function buildMemoryUow(store: Store): UnitOfWork {
  return {
    async run(fn) {
      const snapshot = cloneStore(store);
      try {
        return await fn(buildMemoryRepos(store));
      } catch (error) {
        overwriteStore(store, snapshot);
        throw error;
      }
    },
  };
}

/**
 * Convenience for tests: create a fresh store + matching repos + uow bound to it.
 */
export function createMemoryContext(): { store: Store; repos: Repos; uow: UnitOfWork } {
  const store = createEmptyStore();
  return {
    store,
    repos: buildMemoryRepos(store),
    uow: buildMemoryUow(store),
  };
}
