// 各リポジトリの契約 (port) を束ねて 1 セットとして扱うための型定義
import type { CategoryRepository } from './category-repository';
import type { FaqRepository } from './faq-repository';
import type { NotificationRepository } from './notification-repository';
import type { TicketCommentRepository } from './ticket-comment-repository';
import type { TicketHistoryRepository } from './ticket-history-repository';
import type { TicketRepository } from './ticket-repository';
import type { UserRepository } from './user-repository';

// アプリ全体で使うリポジトリ群 (全ポートをまとめた集合)
export interface Repos {
  tickets: TicketRepository; // チケット操作
  users: UserRepository; // ユーザー操作
  notifications: NotificationRepository; // 通知操作
  faq: FaqRepository; // FAQ 操作
  history: TicketHistoryRepository; // 履歴操作
  comments: TicketCommentRepository; // コメント操作
  categories: CategoryRepository; // カテゴリ操作
}

// トランザクション境界を表す契約 (Unit of Work パターン)
// run に渡した関数内ではトランザクション対応の Repos が使える
export interface UnitOfWork {
  run<T>(fn: (txRepos: Repos) => Promise<T>): Promise<T>;
}
