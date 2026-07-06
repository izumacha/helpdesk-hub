// リポジトリ束 (Repos) と UnitOfWork の型をインポート
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
// 各エンティティ用のメモリリポジトリ生成関数を取り込む
import { makeAttachmentRepo } from './attachment-repository.memory';
import { makeCategoryRepo } from './category-repository.memory';
import { makeEmailThreadRepo } from './email-thread-repository.memory';
import { makeFaqRepo } from './faq-repository.memory';
import { makeInvitationRepo } from './invitation-repository.memory';
import { makeLineConfigRepo } from './line-config-repository.memory';
import { makeLineMessageRepo } from './line-message-repository.memory';
import { makeLocationRepo } from './location-repository.memory';
import { makeMagicLinkRepo } from './magic-link-repository.memory';
import { makeNotificationRepo } from './notification-repository.memory';
import { makeSsoConfigRepo } from './sso-config-repository.memory';
import { cloneStore, createEmptyStore, overwriteStore, type Store } from './store';
import { makeTenantRepo } from './tenant-repository.memory';
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
    tenants: makeTenantRepo(store),
    magicLinks: makeMagicLinkRepo(store),
    invitations: makeInvitationRepo(store),
    attachments: makeAttachmentRepo(store),
    emailThreads: makeEmailThreadRepo(store),
    lineMessages: makeLineMessageRepo(store), // LINE 取り込みの冪等化 (Phase 2)
    locations: makeLocationRepo(store), // Phase 4 多拠点
    ssoConfigs: makeSsoConfigRepo(store), // Phase 4 Enterprise: SAML SSO 設定
    lineConfigs: makeLineConfigRepo(store), // Phase 2 フォローアップ: テナント単位の LINE 連携設定
  };
}

/**
 * Minimal transaction implementation: snapshot store, run callback, restore on throw.
 * Matches the Prisma adapter's all-or-nothing semantics — good enough for unit tests.
 */
// メモリ版 UnitOfWork。スナップショットを取り、例外時に巻き戻す擬似トランザクション
export function buildMemoryUow(store: Store): UnitOfWork {
  return {
    // isolationLevel はメモリ実装では意味を持たない (Node は単一スレッドで、
    // run() 呼び出しの間に他の run() が割り込んで同じキーを読み書きすることは無いため無視する)
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
    // メモリ実装は真の同時実行を扱わないため、書き込み競合エラーは起こり得ない
    isTransactionConflict() {
      return false;
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
