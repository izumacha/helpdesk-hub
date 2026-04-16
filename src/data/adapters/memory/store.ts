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

/**
 * In-memory store used by the test adapter.
 *
 * The `idSeq` counter is per-store so different test contexts never share state
 * and produce stable id sequences in isolation.
 */
export interface Store {
  users: Map<string, User>;
  categories: Map<string, CategoryRow>;
  tickets: Map<string, Ticket>;
  comments: Map<string, TicketComment>;
  histories: Map<string, TicketHistory>;
  faq: Map<string, FaqCandidate>;
  notifications: Map<string, Notification>;
  idSeq: { value: number };
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
    idSeq: { value: 0 },
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
    idSeq: { value: src.idSeq.value },
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
  dst.idSeq.value = src.idSeq.value;
}

/**
 * Per-store id generator. Not a real cuid — the contract test only requires
 * that ids are unique within a store.
 */
export function nextId(store: Store, prefix: string): string {
  store.idSeq.value += 1;
  return `${prefix}_${store.idSeq.value.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
