// 履歴リポジトリの契約 (port) と、メモリストア/ID 生成ヘルパーをインポート
import type { TicketHistoryRepository } from '@/data/ports/ticket-history-repository';
import type { TicketHistory } from '@/domain/types';
import { nextId, type Store } from './store';

// メモリストアを使った履歴リポジトリを生成する関数
export function makeTicketHistoryRepo(store: Store): TicketHistoryRepository {
  return {
    // 履歴を 1 件記録する
    async record(input) {
      // 新しい履歴行を組み立てる
      const row: TicketHistory = {
        id: nextId(store, 'hst'), // 'hst_...' 形式の一意 ID
        ticketId: input.ticketId, // 対象チケット
        changedById: input.changedById, // 変更者
        field: input.field, // 変更対象フィールド
        oldValue: input.oldValue, // 変更前の値
        newValue: input.newValue, // 変更後の値
        createdAt: new Date(), // 変更日時
      };
      // ストアに登録 (返り値はなし)
      store.histories.set(row.id, row);
    },
  };
}
