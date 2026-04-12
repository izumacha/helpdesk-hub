/**
 * In-memory SSE subscriber registry.
 *
 * Safe for single-process deployments (standalone Docker).
 * Each user maps to a Set of ReadableStreamDefaultController instances —
 * one per open browser tab / EventSource connection.
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
