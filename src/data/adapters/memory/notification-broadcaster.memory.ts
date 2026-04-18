import type {
  BroadcastController,
  NotificationBroadcaster,
} from '@/data/ports/notification-broadcaster';

/**
 * In-process Map implementation of `NotificationBroadcaster`.
 *
 * Safe for single-process deployments (standalone Docker) only. Each user maps
 * to a Set of `ReadableStreamDefaultController` instances — one per open
 * browser tab / EventSource connection.
 *
 * Horizontal scaling caveat: when running behind a load balancer with multiple
 * app instances, a `broadcast` call produced on instance B will not reach a
 * user whose EventSource is attached to instance A — the unread count will
 * silently drift until the next cache revalidation. Swap this adapter for a
 * Redis/Postgres-backed one to fix that.
 */
export function createInMemoryNotificationBroadcaster(): NotificationBroadcaster {
  const subscribers = new Map<string, Set<BroadcastController>>();

  const encodeCount = (count: number): Uint8Array =>
    new TextEncoder().encode(`event: count\ndata: ${JSON.stringify({ count })}\n\n`);

  return {
    addSubscriber(userId, controller) {
      let controllers = subscribers.get(userId);
      if (!controllers) {
        controllers = new Set();
        subscribers.set(userId, controllers);
      }
      controllers.add(controller);
    },

    removeSubscriber(userId, controller) {
      const controllers = subscribers.get(userId);
      if (!controllers) return;
      controllers.delete(controller);
      if (controllers.size === 0) {
        subscribers.delete(userId);
      }
    },

    broadcast(userId, count) {
      const controllers = subscribers.get(userId);
      if (!controllers || controllers.size === 0) return;

      const message = encodeCount(count);
      for (const controller of controllers) {
        try {
          controller.enqueue(message);
        } catch {
          controllers.delete(controller);
        }
      }

      if (controllers.size === 0) {
        subscribers.delete(userId);
      }
    },
  };
}
