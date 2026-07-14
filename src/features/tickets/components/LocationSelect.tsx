'use client';

// 非ブロッキングで状態更新を扱う React フック
import { useTransition } from 'react';
// 拠点更新用サーバーアクション
import { updateTicketLocation } from '@/features/tickets/actions/update-ticket';

// 拠点プルダウン項目の型 (ID と表示名)
type Location = { id: string; name: string };

// 受け取る props (チケット ID/現拠点 ID/候補一覧)
interface Props {
  ticketId: string;
  currentLocationId: string | null;
  locations: Location[];
}

// 拠点を切り替えるプルダウン (空文字 = 未指定。AssigneeSelect.tsx と同じ設計)
export function LocationSelect({ ticketId, currentLocationId, locations }: Props) {
  // 送信中フラグ + トランジション関数
  const [isPending, startTransition] = useTransition();

  // 選択変更時にサーバーアクションを呼ぶ (空文字は null=未指定扱い)
  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    startTransition(() => updateTicketLocation(ticketId, val || null));
  }

  return (
    // 現在値を表示しつつ、変更で更新するセレクト
    <select
      value={currentLocationId ?? ''}
      onChange={handleChange}
      disabled={isPending}
      className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
    >
      {/* 空文字 = 未指定 */}
      <option value="">未指定</option>
      {/* 候補となる拠点一覧 */}
      {locations.map((l) => (
        <option key={l.id} value={l.id}>
          {l.name}
        </option>
      ))}
    </select>
  );
}
