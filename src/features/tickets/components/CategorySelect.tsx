'use client';

// 非ブロッキングで状態更新を扱う React フック
import { useTransition } from 'react';
// カテゴリ更新用サーバーアクション
import { updateTicketCategory } from '@/features/tickets/actions/update-ticket';

// カテゴリプルダウン項目の型 (ID と表示名)
type Category = { id: string; name: string };

// 受け取る props (チケット ID/現カテゴリ ID/候補一覧)
interface Props {
  ticketId: string;
  currentCategoryId: string | null;
  categories: Category[];
}

// カテゴリを切り替えるプルダウン (空文字 = 未分類。AssigneeSelect.tsx と同じ設計)
export function CategorySelect({ ticketId, currentCategoryId, categories }: Props) {
  // 送信中フラグ + トランジション関数
  const [isPending, startTransition] = useTransition();

  // 選択変更時にサーバーアクションを呼ぶ (空文字は null=未分類扱い)
  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    startTransition(() => updateTicketCategory(ticketId, val || null));
  }

  return (
    // 現在値を表示しつつ、変更で更新するセレクト
    <select
      value={currentCategoryId ?? ''}
      onChange={handleChange}
      disabled={isPending}
      className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
    >
      {/* 空文字 = 未分類 */}
      <option value="">未分類</option>
      {/* 候補となるカテゴリ一覧 */}
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
