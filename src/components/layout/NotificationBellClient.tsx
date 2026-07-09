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

// レート制限 (429) で接続が閉じられた後、手動で再接続するまでの待ち時間 (ミリ秒)。
// SSE の仕様上、EventSource は非 2xx レスポンスを受け取ると readyState を CLOSED に
// 固定し、ネットワーク切断時と違ってブラウザは二度と自動再接続しないため必要になる
const RECONNECT_DELAY_MS = 10_000;

// 通知ベル本体: 初期件数を表示しつつ、SSE で増減を即時反映
export function NotificationBellClient({ initialCount, userId }: Props) {
  // 表示する未読件数の状態
  const [count, setCount] = useState<number>(initialCount);

  useEffect(() => {
    // アンマウント後に再接続処理が動かないようにするフラグ
    let cancelled = false;
    // 手動再接続の setTimeout 参照 (アンマウント時にキャンセルする)
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    // 現在張っている SSE 接続 (張り替え・クリーンアップ時に close するため外側で保持)
    let es: EventSource;

    // SSE エンドポイントへ接続する処理を関数化 (手動再接続時に再利用するため)
    function connect() {
      // SSE エンドポイントへ新規接続
      es = new EventSource('/api/notifications/stream');

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

      // 接続エラー: ネットワーク切断はブラウザが自動再接続するが、429 等の非 2xx
      // レスポンスによる CLOSED はブラウザが再接続しないため、ここで手動再接続する
      es.addEventListener('error', () => {
        // CLOSED (=ブラウザが再接続を諦めた) かつアンマウント済みでない場合のみ再接続
        if (es.readyState === EventSource.CLOSED && !cancelled) {
          reconnectTimer = setTimeout(() => {
            // タイマー発火時点でまだマウントされていれば再接続
            if (!cancelled) connect();
          }, RECONNECT_DELAY_MS);
        }
      });
    }

    // 初回接続
    connect();

    // アンマウント時に SSE 接続と再接続タイマーを片付ける
    return () => {
      // 以後の再接続をすべて禁止する
      cancelled = true;
      // 保留中の再接続タイマーがあれば止める
      if (reconnectTimer) clearTimeout(reconnectTimer);
      // 現在の SSE 接続を閉じる
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
