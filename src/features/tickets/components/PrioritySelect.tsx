'use client';

// 非ブロッキングでアクションを呼ぶフック
import { useTransition } from 'react';
// 優先度更新サーバーアクション
import { updateTicketPriority } from '@/features/tickets/actions/update-ticket';
// 優先度の日本語ラベル
import { PRIORITY_LABELS } from '@/lib/constants';
// 優先度の型 (Prisma 生成)
import type { Priority } from '@/generated/prisma';

// プルダウンに並べる優先度の順序
const ALL_PRIORITIES: Priority[] = ['Low', 'Medium', 'High'];

// 受け取る props (チケット ID と現在値)
interface Props {
  ticketId: string;
  current: Priority;
}

// 優先度を切り替えるプルダウン (エージェント向け)
export function PrioritySelect({ ticketId, current }: Props) {
  // 送信中フラグ + トランジション
  const [isPending, startTransition] = useTransition();

  // 選択変更で更新アクションを呼ぶ
  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    // value は string なので Priority に明示キャスト
    const next = e.target.value as Priority;
    startTransition(() => updateTicketPriority(ticketId, next));
  }

  return (
    // 現在値を表示しつつ変更を受け付けるセレクト
    <select
      value={current}
      onChange={handleChange}
      disabled={isPending}
      className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
    >
      {/* 全優先度を順に option として描画 */}
      {ALL_PRIORITIES.map((p) => (
        <option key={p} value={p}>{PRIORITY_LABELS[p] ?? p}</option>
      ))}
    </select>
  );
}
