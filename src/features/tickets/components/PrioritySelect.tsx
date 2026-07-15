'use client';

// React フック (エラー状態/送信中トランジション)
import { useState, useTransition } from 'react';
// 失敗時にサーバーの最新状態を取り直すためのルーター
import { useRouter } from 'next/navigation';
// 優先度更新サーバーアクション
import { updateTicketPriority } from '@/features/tickets/actions/update-ticket';
// 優先度の日本語ラベル
import { PRIORITY_LABELS } from '@/lib/constants';
// 優先度の型 (正準のドメイン型)
import type { Priority } from '@/domain/types';

// プルダウンに並べる優先度の順序
const ALL_PRIORITIES: Priority[] = ['Low', 'Medium', 'High'];

// 受け取る props (チケット ID と現在値)
interface Props {
  ticketId: string;
  current: Priority;
}

// フォローアップ (2026-07-15 #3): updateTicketPriority も updateTicketStatus と同じく
// check-then-act 競合時に Error を throw するようになったため、StatusSelect と同じく
// 送信中はセレクトを無効化しエラーはその場に表示する
// 優先度を切り替えるプルダウン (エージェント向け)
export function PrioritySelect({ ticketId, current }: Props) {
  // 失敗時にサーバーの最新状態を取り直すためのルーター
  const router = useRouter();
  // 送信中フラグ + トランジション
  const [isPending, startTransition] = useTransition();
  // サーバーアクションから返ったエラーを表示する
  const [error, setError] = useState<string | null>(null);

  // 選択変更で更新アクションを呼ぶ (競合・レート制限等の失敗はその場にエラー表示する)
  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    // value は string なので Priority に明示キャスト
    const next = e.target.value as Priority;
    // 直前のエラー表示をクリア
    setError(null);
    startTransition(async () => {
      try {
        await updateTicketPriority(ticketId, next);
      } catch (err) {
        // 失敗時はエラーメッセージを画面表示 (§6 エラーを握り潰さない)
        setError(err instanceof Error ? err.message : 'エラーが発生しました');
        // 競合エラーは「画面の表示が古い」ことを意味するため、サーバーの最新状態を取り直して
        // 古いプルダウンの値が残り続けるのを防ぐ
        router.refresh();
      }
    });
  }

  return (
    <div>
      {/* 現在値を表示しつつ変更を受け付けるセレクト */}
      <select
        value={current}
        onChange={handleChange}
        disabled={isPending}
        className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
      >
        {/* 全優先度を順に option として描画 */}
        {ALL_PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABELS[p] ?? p}
          </option>
        ))}
      </select>
      {/* エラー表示 (ある場合のみ。role="alert" でスクリーンリーダーにも即時に伝える。§7 a11y) */}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
