// 履歴リポジトリの契約 (port) と、メモリストア/ID 生成ヘルパーをインポート
import type { TicketHistoryRepository, TicketHistoryWithRefs } from '@/data/ports/ticket-history-repository';
import type { TicketHistory } from '@/domain/types';
import { nextId, type Store } from './store';

// 取得件数の既定値 (Prisma 実装と揃える)
const AUDIT_DEFAULT_LIMIT = 100;

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

    // Phase 4: テナント全体の変更履歴を監査ログとして取得する (テスト用メモリ実装)
    async findAllByTenant(filter) {
      // 件数上限 (DoS 対策として上限を設ける)
      const limit = filter.limit ?? AUDIT_DEFAULT_LIMIT;
      const offset = filter.offset ?? 0;

      // メモリストアからテナントスコープで絞り込む
      // Ticket を通じて tenantId を間接的に確認する (TicketHistory に tenantId なし)
      const rows: TicketHistoryWithRefs[] = [];
      for (const h of store.histories.values()) {
        // 対象チケットを取得して tenantId を確認する
        const ticket = store.tickets.get(h.ticketId);
        // チケットが存在しない or 別テナントならスキップ (クロステナント漏洩防止)
        if (!ticket || ticket.tenantId !== filter.tenantId) continue;
        // 変更者を取得する
        const user = store.users.get(h.changedById);
        // 変更者が存在しない場合は「不明」で代替する (データ不整合のフォールバック)
        rows.push({
          id: h.id, // 履歴 ID
          ticketId: h.ticketId, // チケット ID
          ticketTitle: ticket.title, // チケット件名
          changedById: h.changedById, // 変更者 ID
          changedByName: user?.name ?? '不明', // 変更者氏名 (存在しない場合は「不明」)
          field: h.field, // 変更項目
          oldValue: h.oldValue, // 変更前の値
          newValue: h.newValue, // 変更後の値
          createdAt: h.createdAt, // 変更日時
        });
      }
      // 新しい順に並べてページネーションを適用する
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return rows.slice(offset, offset + limit);
    },
  };
}
