'use client';

// 担当者更新用サーバーアクション
import { updateTicketAssignee } from '@/features/tickets/actions/update-ticket';
// チケット詳細ページの各種プルダウンが共有する汎用セレクト。
// /code-review ultra 指摘対応 (フォローアップ 2026-07-14 #4): CategorySelect/LocationSelect
// 追加時に同型のプルダウンが 3 箇所目の重複になったため、表示ロジックを EntitySelect へ
// 共通化した (§6 DRY)。挙動 (value/onChange/disabled/クラス名) は変更していない。
import { EntitySelect, type EntityOption } from '@/features/tickets/components/EntitySelect';

// 受け取る props (チケット ID/現担当者 ID/候補一覧)
interface Props {
  ticketId: string;
  currentAssigneeId: string | null;
  agents: EntityOption[];
}

// 担当者を切り替えるプルダウン (空文字 = 未割当)
export function AssigneeSelect({ ticketId, currentAssigneeId, agents }: Props) {
  return (
    <EntitySelect
      currentId={currentAssigneeId}
      options={agents}
      emptyLabel="未割当"
      onChange={(newId) => updateTicketAssignee(ticketId, newId)}
    />
  );
}
