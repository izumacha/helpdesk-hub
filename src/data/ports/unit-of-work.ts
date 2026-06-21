// 各リポジトリの契約 (port) を束ねて 1 セットとして扱うための型定義
import type { AttachmentRepository } from './attachment-repository';
import type { CategoryRepository } from './category-repository';
import type { EmailThreadRepository } from './email-thread-repository';
import type { FaqRepository } from './faq-repository';
import type { InvitationRepository } from './invitation-repository';
import type { MagicLinkRepository } from './magic-link-repository';
import type { NotificationRepository } from './notification-repository';
import type { TenantRepository } from './tenant-repository';
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
  tenants: TenantRepository; // テナント操作 (マルチテナント化)
  magicLinks: MagicLinkRepository; // マジックリンクトークン操作 (パスワードレス認証)
  invitations: InvitationRepository; // 招待リンクトークン操作 (メンバー招待)
  attachments: AttachmentRepository; // 添付ファイル (画像) のメタ情報操作
  emailThreads: EmailThreadRepository; // メール Message-ID → チケット 対応表 (スレッド継続 / Phase 2)
}

// トランザクション境界を表す契約 (Unit of Work パターン)
// run に渡した関数内ではトランザクション対応の Repos が使える
export interface UnitOfWork {
  run<T>(fn: (txRepos: Repos) => Promise<T>): Promise<T>;
}
