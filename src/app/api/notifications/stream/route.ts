import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getUnreadNotificationCount } from '@/lib/notifications';
import { addSubscriber, removeSubscriber } from '@/lib/sse-subscribers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KEEPALIVE_INTERVAL_MS = 30_000;

const encoder = new TextEncoder();

function sseComment(text: string): Uint8Array {
  return encoder.encode(`: ${text}\n\n`);
}

function sseEvent(eventName: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }
  const userId = session.user.id;

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      controller = ctrl;
      addSubscriber(userId, controller);

      try {
        const initialCount = await getUnreadNotificationCount(userId);
        controller.enqueue(sseEvent('count', { count: initialCount }));
      } catch {
        // Non-fatal — client will receive future broadcast events.
      }

      keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(sseComment('ping'));
        } catch {
          clearInterval(keepaliveTimer);
        }
      }, KEEPALIVE_INTERVAL_MS);
    },

    cancel() {
      clearInterval(keepaliveTimer);
      removeSubscriber(userId, controller);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
