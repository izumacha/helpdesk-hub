'use client';

// 副作用フックと状態フック
import { useEffect, useState } from 'react';
// クライアント遷移付きリンク
import Link from 'next/link';

// 未読件数の初期値とユーザー ID を受け取る
interface Props {
  initialCount: number;
  userId: string;
}

// 通知ベル本体: 初期件数を表示しつつ、SSE で増減を即時反映
export function NotificationBellClient({ initialCount, userId }: Props) {
  // 表示する未読件数の状態
  const [count, setCount] = useState<number>(initialCount);

  useEffect(() => {
    // SSE エンドポイントへ接続 (再接続はブラウザが自動で行う)
    const es = new EventSource('/api/notifications/stream');

    // count イベント受信時: 未読件数を更新
    es.addEventListener('count', (event: MessageEvent) => {
      try {
        // JSON パースして件数を取り出す
        const data = JSON.parse(event.data) as { count: number };
        setCount(data.count);
      } catch {
        // 形式不正は握りつぶす (次のイベントで復旧する)
      }
    });

    // 接続エラーは無視 (EventSource が自動再接続するためコンソールを汚さない)
    es.addEventListener('error', () => {});

    // アンマウント時に SSE 接続を閉じる
    return () => {
      es.close();
    };
  }, [userId]);

  return (
    // 通知一覧ページへの導線 + 未読バッジ (件数 > 0 のみ)
    <Link href="/notifications" className="relative text-sm text-gray-700 hover:text-gray-900">
      通知
      {count > 0 && (
        // 件数は 9 件超なら "9+" に省略
        <span className="absolute -right-2 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </Link>
  );
}
