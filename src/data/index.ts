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
import { createInMemoryNotificationBroadcaster } from './adapters/memory/notification-broadcaster.memory';
import { buildPrismaRepos, buildPrismaUow } from './adapters/prisma';
import type { NotificationBroadcaster } from './ports/notification-broadcaster';
import type { Repos, UnitOfWork } from './ports/unit-of-work';

export type { Repos, UnitOfWork } from './ports/unit-of-work';
export type { NotificationBroadcaster } from './ports/notification-broadcaster';

export const repos: Repos = buildPrismaRepos(prisma);
export const uow: UnitOfWork = buildPrismaUow(prisma);

/**
 * Default notification broadcaster: single-process in-memory registry.
 *
 * Multi-instance deployments must replace this with a Redis / Postgres
 * `LISTEN/NOTIFY` adapter (see `src/data/ports/notification-broadcaster.ts`
 * and GitHub issue #60).
 */
export const notificationBroadcaster: NotificationBroadcaster =
  createInMemoryNotificationBroadcaster();
