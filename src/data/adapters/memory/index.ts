// リポジトリ束 (Repos) と UnitOfWork の型をインポート
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
// 各エンティティ用のメモリリポジトリ生成関数を取り込む
import { makeCategoryRepo } from './category-repository.memory';
import { makeFaqRepo } from './faq-repository.memory';
import { makeNotificationRepo } from './notification-repository.memory';
import { cloneStore, createEmptyStore, overwriteStore, type Store } from './store';
import { makeTicketCommentRepo } from './ticket-comment-repository.memory';
import { makeTicketHistoryRepo } from './ticket-history-repository.memory';
import { makeTicketRepo } from './ticket-repository.memory';
import { makeUserRepo } from './user-repository.memory';

// Store 型と空ストアファクトリを外部にも再公開 (テストで使用)
export type { Store } from './store';
export { createEmptyStore } from './store';

// 指定ストアを使った全リポジトリ一式 (Repos) を組み立てて返す関数
export function buildMemoryRepos(store: Store): Repos {
  // 各ポートに対応するメモリ実装を組み立てる
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
// メモリ版 UnitOfWork。スナップショットを取り、例外時に巻き戻す擬似トランザクション
export function buildMemoryUow(store: Store): UnitOfWork {
  return {
    async run(fn) {
      const snapshot = cloneStore(store); // トランザクション開始時点のスナップショット
      try {
        // 実際の処理を同じストア上で実行
        return await fn(buildMemoryRepos(store));
      } catch (error) {
        // 失敗したらストアをスナップショットに戻す (ロールバック相当)
        overwriteStore(store, snapshot);
        // エラーは呼び出し元に再 throw
        throw error;
      }
    },
  };
}

/**
 * Convenience for tests: create a fresh store + matching repos + uow bound to it.
 */
// テスト用に「新規ストア + リポジトリ一式 + UoW」をまとめて生成するヘルパー
export function createMemoryContext(): { store: Store; repos: Repos; uow: UnitOfWork } {
  const store = createEmptyStore(); // 空ストアを作成
  // 同一ストアに紐づく repos と uow を組み立てて返す
  return {
    store,
    repos: buildMemoryRepos(store),
    uow: buildMemoryUow(store),
  };
}
