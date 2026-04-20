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

// SSE 接続 1 本分を表すコントローラー型 (Web 標準 ReadableStream のコントローラー)
export type BroadcastController = ReadableStreamDefaultController<Uint8Array>;

// 通知ブロードキャスタの契約 (port)
// 実装は in-memory Map だったり、将来的には Redis pub/sub だったりする
export interface NotificationBroadcaster {
  addSubscriber(userId: string, controller: BroadcastController): void; // ユーザーの SSE 接続を登録
  removeSubscriber(userId: string, controller: BroadcastController): void; // 接続を解除
  broadcast(userId: string, count: number): void; // 指定ユーザーの全接続に未読件数を送信
}
