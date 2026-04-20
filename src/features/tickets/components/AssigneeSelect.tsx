'use client';

// 非ブロッキングで状態更新を扱う React フック
import { useTransition } from 'react';
// 担当者更新用サーバーアクション
import { updateTicketAssignee } from '@/features/tickets/actions/update-ticket';

// 担当者プルダウン項目の型 (ID と表示名)
type Agent = { id: string; name: string };

// 受け取る props (チケット ID/現担当者 ID/候補一覧)
interface Props {
  ticketId: string;
  currentAssigneeId: string | null;
  agents: Agent[];
}

// 担当者を切り替えるプルダウン (空文字 = 未割当)
export function AssigneeSelect({ ticketId, currentAssigneeId, agents }: Props) {
  // 送信中フラグ + トランジション関数
  const [isPending, startTransition] = useTransition();

  // 選択変更時にサーバーアクションを呼ぶ (空文字は null=未割当扱い)
  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    startTransition(() => updateTicketAssignee(ticketId, val || null));
  }

  return (
    // 現在値を表示しつつ、変更で更新するセレクト
    <select
      value={currentAssigneeId ?? ''}
      onChange={handleChange}
      disabled={isPending}
      className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
    >
      {/* 空文字 = 未割当 */}
      <option value="">未割当</option>
      {/* 候補となるエージェント一覧 */}
      {agents.map((a) => (
        <option key={a.id} value={a.id}>{a.name}</option>
      ))}
    </select>
  );
}
