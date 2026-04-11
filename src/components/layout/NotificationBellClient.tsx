'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Props {
  initialCount: number;
  userId: string;
}

export function NotificationBellClient({ initialCount, userId }: Props) {
  const [count, setCount] = useState<number>(initialCount);

  useEffect(() => {
    const es = new EventSource('/api/notifications/stream');

    es.addEventListener('count', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { count: number };
        setCount(data.count);
      } catch {
        // Malformed data — ignore.
      }
    });

    // Suppress unhandled-error console noise; EventSource auto-reconnects.
    es.addEventListener('error', () => {});

    return () => {
      es.close();
    };
  }, [userId]);

  return (
    <Link href="/notifications" className="relative text-sm text-gray-700 hover:text-gray-900">
      通知
      {count > 0 && (
        <span className="absolute -right-2 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </Link>
  );
}
