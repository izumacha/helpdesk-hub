/**
 * Port: notification broadcaster.
 *
 * Abstracts the delivery of unread-count SSE events to connected clients.
 * The SSE route handler and Server Actions depend on this port, not on any
 * concrete registry implementation. Swap adapters (Redis pub/sub, Postgres
 * `LISTEN/NOTIFY`, etc.) without touching the call sites.
 *
 * Tracking: see GitHub issue #60.
 */

export type BroadcastController = ReadableStreamDefaultController<Uint8Array>;

export interface NotificationBroadcaster {
  addSubscriber(userId: string, controller: BroadcastController): void;
  removeSubscriber(userId: string, controller: BroadcastController): void;
  broadcast(userId: string, count: number): void;
}
