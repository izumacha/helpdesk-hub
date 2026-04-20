/**
 * Composition root for the data layer.
 *
 * Feature code (Server Actions, pages, API routes) must only import from
 * `@/data` — never directly from `@/lib/prisma` or `@/generated/prisma`.
 *
 * Swapping the adapter (for a future ORM or DB engine) only requires changing
 * this file. The public `repos` / `uow` surface stays identical.
 */

// Prisma クライアントのシングルトンを取り込む
import { prisma } from '@/lib/prisma';
// メモリ版の通知ブロードキャスタ実装
import { createInMemoryNotificationBroadcaster } from './adapters/memory/notification-broadcaster.memory';
// Prisma 版のリポジトリ束と UnitOfWork 生成関数
import { buildPrismaRepos, buildPrismaUow } from './adapters/prisma';
// ポート型 (外部アプリコードへの公開契約)
import type { NotificationBroadcaster } from './ports/notification-broadcaster';
import type { Repos, UnitOfWork } from './ports/unit-of-work';

// 外部アプリコードで使う型だけを再公開する (データ層の公開 API)
export type { Repos, UnitOfWork } from './ports/unit-of-work';
export type { NotificationBroadcaster } from './ports/notification-broadcaster';

// アプリ全体で共有する Prisma 版のリポジトリ束
export const repos: Repos = buildPrismaRepos(prisma);
// アプリ全体で共有する Prisma 版の UnitOfWork (トランザクション境界)
export const uow: UnitOfWork = buildPrismaUow(prisma);

/**
 * Default notification broadcaster: single-process in-memory registry.
 *
 * Multi-instance deployments must replace this with a Redis / Postgres
 * `LISTEN/NOTIFY` adapter (see `src/data/ports/notification-broadcaster.ts`
 * and GitHub issue #60).
 */
// 既定の通知ブロードキャスタ (プロセス内 Map 実装)
// 複数インスタンス展開時は外部ストア版に差し替えること
export const notificationBroadcaster: NotificationBroadcaster =
  createInMemoryNotificationBroadcaster();
