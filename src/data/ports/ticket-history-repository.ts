// 履歴項目の種類 (status/priority/assignee/escalation) を示す型をインポート
import type { HistoryField } from '@/domain/types';

// 履歴 1 件を記録する際に渡す入力値
export interface RecordHistoryInput {
  ticketId: string; // どのチケットの履歴か
  changedById: string; // 変更を行ったユーザー ID
  field: HistoryField; // 変更項目の種類
  oldValue: string | null; // 変更前の値 (null 可)
  newValue: string | null; // 変更後の値 (null 可)
}

// チケット履歴書き込み用リポジトリの契約 (port)
export interface TicketHistoryRepository {
  record(input: RecordHistoryInput): Promise<void>; // 履歴を 1 件追加する
}
