import type { CategoryRepository } from './category-repository';
import type { FaqRepository } from './faq-repository';
import type { NotificationRepository } from './notification-repository';
import type { TicketCommentRepository } from './ticket-comment-repository';
import type { TicketHistoryRepository } from './ticket-history-repository';
import type { TicketRepository } from './ticket-repository';
import type { UserRepository } from './user-repository';

export interface Repos {
  tickets: TicketRepository;
  users: UserRepository;
  notifications: NotificationRepository;
  faq: FaqRepository;
  history: TicketHistoryRepository;
  comments: TicketCommentRepository;
  categories: CategoryRepository;
}

export interface UnitOfWork {
  run<T>(fn: (txRepos: Repos) => Promise<T>): Promise<T>;
}
