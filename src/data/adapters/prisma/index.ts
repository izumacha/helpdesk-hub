import type { PrismaClient } from '@/generated/prisma';
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
import { makeCategoryRepo } from './category-repository.prisma';
import { makeFaqRepo } from './faq-repository.prisma';
import { makeNotificationRepo } from './notification-repository.prisma';
import { makeTicketCommentRepo } from './ticket-comment-repository.prisma';
import { makeTicketHistoryRepo } from './ticket-history-repository.prisma';
import { makeTicketRepo } from './ticket-repository.prisma';
import { makeUserRepo } from './user-repository.prisma';
import type { PrismaLike } from './types';

export type { PrismaLike } from './types';

export function buildPrismaRepos(db: PrismaLike): Repos {
  return {
    tickets: makeTicketRepo(db),
    users: makeUserRepo(db),
    notifications: makeNotificationRepo(db),
    faq: makeFaqRepo(db),
    history: makeTicketHistoryRepo(db),
    comments: makeTicketCommentRepo(db),
    categories: makeCategoryRepo(db),
  };
}

export function buildPrismaUow(client: PrismaClient): UnitOfWork {
  return {
    async run(fn) {
      return client.$transaction(async (tx) => fn(buildPrismaRepos(tx)));
    },
  };
}
