/**
 * Thin facade over the `NotificationBroadcaster` port.
 *
 * Historic call sites (SSE route handler, Server Actions) keep importing
 * `addSubscriber` / `removeSubscriber` / `broadcast` from this module. The
 * actual registry lives in `@/data` and can be swapped to a Redis / Postgres
 * `LISTEN/NOTIFY` adapter without touching these call sites.
 *
 * Tracking: see GitHub issue #60.
 */

import { notificationBroadcaster } from '@/data';

export type Controller = ReadableStreamDefaultController<Uint8Array>;

export function addSubscriber(userId: string, controller: Controller): void {
  notificationBroadcaster.addSubscriber(userId, controller);
}

export function removeSubscriber(userId: string, controller: Controller): void {
  notificationBroadcaster.removeSubscriber(userId, controller);
}

export function broadcast(userId: string, count: number): void {
  notificationBroadcaster.broadcast(userId, count);
}
