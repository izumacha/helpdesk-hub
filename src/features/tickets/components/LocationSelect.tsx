'use client';

// 拠点更新用サーバーアクション
import { updateTicketLocation } from '@/features/tickets/actions/update-ticket';
// チケット詳細ページの各種プルダウンが共有する汎用セレクト (§6 DRY)
import { EntitySelect, type EntityOption } from '@/features/tickets/components/EntitySelect';

// 受け取る props (チケット ID/現拠点 ID/候補一覧/紐付け先ラベルの id)
interface Props {
  ticketId: string;
  currentLocationId: string | null;
  locations: EntityOption[];
  labelledBy: string;
}

// 拠点を切り替えるプルダウン (空文字 = 未指定)
export function LocationSelect({ ticketId, currentLocationId, locations, labelledBy }: Props) {
  return (
    <EntitySelect
      currentId={currentLocationId}
      options={locations}
      emptyLabel="未指定"
      onChange={(newId) => updateTicketLocation(ticketId, newId)}
      labelledBy={labelledBy}
    />
  );
}
