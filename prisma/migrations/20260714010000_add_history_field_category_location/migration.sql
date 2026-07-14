-- フォローアップ (2026-07-14 #4): 監査で発見したギャップの解消。
-- メール/LINE 取り込みで作成されたチケットは categoryId/locationId を設定する手段が無く
-- 永久に未設定のままだった。事後変更 (updateTicketCategory / updateTicketLocation) を
-- 追加するにあたり、他の変更可能フィールド (status/priority/assignee/escalation) と同じく
-- TicketHistory に変更履歴を残せるようにする。
ALTER TYPE "HistoryField" ADD VALUE 'category';
ALTER TYPE "HistoryField" ADD VALUE 'location';
