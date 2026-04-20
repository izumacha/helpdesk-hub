// Prisma クライアントのシングルトンを読み込む (DB 書き込みに使用)
import { prisma } from '@/lib/prisma';
// 履歴の「どの項目が変わったか」を示す型をインポート
import type { HistoryField } from '@/generated/prisma';

// チケットの変更履歴を 1 件 DB に追加する共通関数
// 呼び出し側は status/priority/assignee/escalation のいずれかが変わったときに呼ぶ
export async function recordHistory(
  ticketId: string, // どのチケットの履歴か
  changedById: string, // 変更を行ったユーザーの ID
  field: HistoryField, // 変更された項目の種類
  oldValue: string | null, // 変更前の値 (初回は null もあり得る)
  newValue: string | null, // 変更後の値
) {
  // TicketHistory テーブルに 1 行挿入する (await で完了を待つ)
  await prisma.ticketHistory.create({
    data: { ticketId, changedById, field, oldValue, newValue },
  });
}
