import { describe, expect, it, vi } from 'vitest';
import { createInMemoryNotificationBroadcaster } from '@/data/adapters/memory/notification-broadcaster.memory';
import type { BroadcastController } from '@/data/ports/notification-broadcaster';

function fakeController(): BroadcastController & { enqueue: ReturnType<typeof vi.fn> } {
  return {
    enqueue: vi.fn(),
    close: vi.fn(),
    error: vi.fn(),
    desiredSize: 1,
  } as unknown as BroadcastController & { enqueue: ReturnType<typeof vi.fn> };
}

function decodeCount(chunk: unknown): number {
  const text = new TextDecoder().decode(chunk as Uint8Array);
  const match = text.match(/data: (\{.*?\})/);
  if (!match) throw new Error(`no data payload in chunk: ${text}`);
  return JSON.parse(match[1]).count as number;
}

describe('in-memory notification broadcaster', () => {
  it('delivers broadcasts to every open controller for the target user', () => {
    const broadcaster = createInMemoryNotificationBroadcaster();
    const ctrlA1 = fakeController();
    const ctrlA2 = fakeController();
    const ctrlB = fakeController();

    broadcaster.addSubscriber('user-a', ctrlA1);
    broadcaster.addSubscriber('user-a', ctrlA2);
    broadcaster.addSubscriber('user-b', ctrlB);

    broadcaster.broadcast('user-a', 3);

    expect(ctrlA1.enqueue).toHaveBeenCalledTimes(1);
    expect(ctrlA2.enqueue).toHaveBeenCalledTimes(1);
    expect(ctrlB.enqueue).not.toHaveBeenCalled();
    expect(decodeCount(ctrlA1.enqueue.mock.calls[0][0])).toBe(3);
  });

  it('removes a controller on removeSubscriber', () => {
    const broadcaster = createInMemoryNotificationBroadcaster();
    const ctrl = fakeController();

    broadcaster.addSubscriber('user-a', ctrl);
    broadcaster.removeSubscriber('user-a', ctrl);
    broadcaster.broadcast('user-a', 1);

    expect(ctrl.enqueue).not.toHaveBeenCalled();
  });

  it('is a no-op when broadcasting to an unknown user', () => {
    const broadcaster = createInMemoryNotificationBroadcaster();
    expect(() => broadcaster.broadcast('ghost', 5)).not.toThrow();
  });

  it('silently drops a controller whose enqueue throws', () => {
    const broadcaster = createInMemoryNotificationBroadcaster();
    const healthy = fakeController();
    const broken = fakeController();
    broken.enqueue.mockImplementation(() => {
      throw new Error('stream closed');
    });

    broadcaster.addSubscriber('user-a', healthy);
    broadcaster.addSubscriber('user-a', broken);

    broadcaster.broadcast('user-a', 2);
    expect(healthy.enqueue).toHaveBeenCalledTimes(1);

    broken.enqueue.mockClear();
    broadcaster.broadcast('user-a', 4);
    expect(broken.enqueue).not.toHaveBeenCalled();
    expect(healthy.enqueue).toHaveBeenCalledTimes(2);
  });

  it('isolates state between independent broadcaster instances', () => {
    const a = createInMemoryNotificationBroadcaster();
    const b = createInMemoryNotificationBroadcaster();
    const ctrl = fakeController();

    a.addSubscriber('user-a', ctrl);
    b.broadcast('user-a', 9);

    expect(ctrl.enqueue).not.toHaveBeenCalled();
  });
});
