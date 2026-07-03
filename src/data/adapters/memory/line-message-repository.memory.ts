// LINE メッセージ対応表リポジトリの契約 (port) と、メモリストア/ID 生成ヘルパーをインポート
import type { LineMessageRepository } from '@/data/ports/line-message-repository';
import { nextId, type LineMessageRefRow, type Store } from './store';

// メモリストアを使った LineMessageRef リポジトリを生成する関数
export function makeLineMessageRepo(store: Store): LineMessageRepository {
  return {
    // この LINE メッセージ ID が既に取り込み済みなら、紐づくチケット ID を返す (tenantId スコープ)
    async findTicketIdByMessageId(lineMessageId, tenantId) {
      // tenantId 一致かつ lineMessageId が一致する行を探す (クロステナント遮断 §9)
      const row = Array.from(store.lineMessageRefs.values()).find(
        (r) => r.tenantId === tenantId && r.lineMessageId === lineMessageId,
      );
      // 見つかれば ticketId、無ければ null
      return row?.ticketId ?? null;
    },

    // LINE メッセージ ID とチケットの対応を 1 件登録する (冪等)
    async register(input) {
      // 既に同じ (tenantId, lineMessageId) があれば何もしない (Webhook 再送でも二重登録しない)
      const duplicated = Array.from(store.lineMessageRefs.values()).some(
        (row) => row.tenantId === input.tenantId && row.lineMessageId === input.lineMessageId,
      );
      if (duplicated) return;
      // 新規行を組み立てる (ID と記録日時はここで決定)
      const row: LineMessageRefRow = {
        id: nextId(store, 'lmr'), // 'lmr_...' 形式の一意 ID
        lineMessageId: input.lineMessageId, // LINE メッセージ ID
        ticketId: input.ticketId, // 紐づくチケット
        tenantId: input.tenantId, // 所属テナント
        createdAt: new Date(), // 現在時刻
      };
      // ストアに登録
      store.lineMessageRefs.set(row.id, row);
    },
  };
}
