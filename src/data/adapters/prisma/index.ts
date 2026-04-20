// Prisma クライアント型と、リポジトリ束/UnitOfWork の契約型をインポート
import type { PrismaClient } from '@/generated/prisma';
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
// 各エンティティ用の Prisma リポジトリ生成関数を取り込む
import { makeCategoryRepo } from './category-repository.prisma';
import { makeFaqRepo } from './faq-repository.prisma';
import { makeNotificationRepo } from './notification-repository.prisma';
import { makeTicketCommentRepo } from './ticket-comment-repository.prisma';
import { makeTicketHistoryRepo } from './ticket-history-repository.prisma';
import { makeTicketRepo } from './ticket-repository.prisma';
import { makeUserRepo } from './user-repository.prisma';
// Prisma クライアント/トランザクション共通型
import type { PrismaLike } from './types';

// 共通型を外部にも再公開 (別のモジュールから使うため)
export type { PrismaLike } from './types';

// 指定 Prisma クライアント (または tx) で動く全リポジトリを組み立てて返す関数
export function buildPrismaRepos(db: PrismaLike): Repos {
  // 各ポートに対応する Prisma 実装を組み立てる
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

// Prisma の $transaction を用いた UnitOfWork 実装を生成する関数
export function buildPrismaUow(client: PrismaClient): UnitOfWork {
  return {
    // run に渡した関数をトランザクション内で実行する
    async run(fn) {
      // Prisma のトランザクションを開始し、tx クライアント用の Repos を渡して実行
      return client.$transaction(async (tx) => fn(buildPrismaRepos(tx)));
    },
  };
}
