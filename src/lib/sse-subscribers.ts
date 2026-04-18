/**
 * In-memory SSE subscriber registry.
 *
 * Safe for single-process deployments (standalone Docker) ONLY.
 * Each user maps to a Set of ReadableStreamDefaultController instances —
 * one per open browser tab / EventSource connection.
 *
 * Horizontal scaling caveat: when running behind a load balancer with
 * multiple app instances, a notification produced on instance B will not
 * reach a user whose EventSource is attached to instance A — the unread
 * count will silently drift until the next page load (60 s cache TTL).
 *
 * To support multi-instance deployments, replace this Map-backed registry
 * with a Redis pub/sub or Postgres LISTEN/NOTIFY adapter. Keep the
 * exported function signatures (`addSubscriber` / `removeSubscriber` /
 * `broadcast`) stable so the SSE route handler does not change.
 *
 * Tracking: see GitHub issue #60.
 */

type Controller = ReadableStreamDefaultController<Uint8Array>;

const subscribers = new Map<string, Set<Controller>>();

export function addSubscriber(userId: string, controller: Controller): void {
  let controllers = subscribers.get(userId);
  if (!controllers) {
    controllers = new Set();
    subscribers.set(userId, controllers);
  }
  controllers.add(controller);
}

export function removeSubscriber(userId: string, controller: Controller): void {
  const controllers = subscribers.get(userId);
  if (!controllers) return;
  controllers.delete(controller);
  if (controllers.size === 0) {
    subscribers.delete(userId);
  }
}

/**
 * Send a "count" SSE event to every open stream for a given user.
 * Silently drops a controller if enqueue throws (client already disconnected).
 */
export function broadcast(userId: string, count: number): void {
  const controllers = subscribers.get(userId);
  if (!controllers || controllers.size === 0) return;

  const message = new TextEncoder().encode(
    `event: count\ndata: ${JSON.stringify({ count })}\n\n`,
  );

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
}
