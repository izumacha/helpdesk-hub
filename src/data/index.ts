/**
 * Composition root for the data layer.
 *
 * Feature code (Server Actions, pages, API routes) must only import from
 * `@/data` — never directly from `@/lib/prisma` or `@/generated/prisma`.
 *
 * Swapping the adapter (for a future ORM or DB engine) only requires changing
 * this file. The public `repos` / `uow` surface stays identical.
 */

import { prisma } from '@/lib/prisma';
import { buildPrismaRepos, buildPrismaUow } from './adapters/prisma';
import type { Repos, UnitOfWork } from './ports/unit-of-work';

export type { Repos, UnitOfWork } from './ports/unit-of-work';

export const repos: Repos = buildPrismaRepos(prisma);
export const uow: UnitOfWork = buildPrismaUow(prisma);
