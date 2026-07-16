'use client';

// カテゴリ更新用サーバーアクション
import { updateTicketCategory } from '@/features/tickets/actions/update-ticket';
// チケット詳細ページの各種プルダウンが共有する汎用セレクト (§6 DRY)
import { EntitySelect, type EntityOption } from '@/features/tickets/components/EntitySelect';

// 受け取る props (チケット ID/現カテゴリ ID/候補一覧/紐付け先ラベルの id)
interface Props {
  ticketId: string;
  currentCategoryId: string | null;
  categories: EntityOption[];
  labelledBy: string;
}

// カテゴリを切り替えるプルダウン (空文字 = 未分類)
export function CategorySelect({ ticketId, currentCategoryId, categories, labelledBy }: Props) {
  return (
    <EntitySelect
      currentId={currentCategoryId}
      options={categories}
      emptyLabel="未分類"
      onChange={(newId) => updateTicketCategory(ticketId, newId)}
      labelledBy={labelledBy}
    />
  );
}
