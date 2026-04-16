import type {
  FaqCandidate,
  Notification,
  Ticket,
  TicketComment,
  TicketHistory,
  User,
} from '@/domain/types';

export interface CategoryRow {
  id: string;
  name: string;
  createdAt: Date;
}

export interface Store {
  users: Map<string, User>;
  categories: Map<string, CategoryRow>;
  tickets: Map<string, Ticket>;
  comments: Map<string, TicketComment>;
  histories: Map<string, TicketHistory>;
  faq: Map<string, FaqCandidate>;
  notifications: Map<string, Notification>;
}

export function createEmptyStore(): Store {
  return {
    users: new Map(),
    categories: new Map(),
    tickets: new Map(),
    comments: new Map(),
    histories: new Map(),
    faq: new Map(),
    notifications: new Map(),
  };
}

export function cloneStore(src: Store): Store {
  return {
    users: new Map(src.users),
    categories: new Map(src.categories),
    tickets: new Map(src.tickets),
    comments: new Map(src.comments),
    histories: new Map(src.histories),
    faq: new Map(src.faq),
    notifications: new Map(src.notifications),
  };
}

export function overwriteStore(dst: Store, src: Store): void {
  dst.users = new Map(src.users);
  dst.categories = new Map(src.categories);
  dst.tickets = new Map(src.tickets);
  dst.comments = new Map(src.comments);
  dst.histories = new Map(src.histories);
  dst.faq = new Map(src.faq);
  dst.notifications = new Map(src.notifications);
}

let idCounter = 0;
/**
 * Deterministic-ish ID generator for the in-memory store.
 * Not a real cuid — the contract test only cares that IDs are unique.
 */
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
