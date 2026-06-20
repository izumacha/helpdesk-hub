// メールスレッド対応表リポジトリの契約 (port) と、メモリストア/ID 生成ヘルパーをインポート
import type { EmailThreadRepository } from '@/data/ports/email-thread-repository';
import { nextId, type EmailThreadRefRow, type Store } from './store';

// メモリストアを使った EmailThreadRef リポジトリを生成する関数
export function makeEmailThreadRepo(store: Store): EmailThreadRepository {
  return {
    // 参照 Message-ID 群から、紐づく既存チケット ID を 1 件返す (tenantId スコープ)
    async findTicketIdByMessageIds(messageIds, tenantId) {
      // 参照が無ければ突き合わせ不要
      if (messageIds.length === 0) return null;
      // 高速に判定するため参照 ID を Set 化する
      const wanted = new Set(messageIds);
      // tenantId 一致かつ messageId が参照集合に含まれる行を集める (クロステナント遮断 §9)
      const matches = Array.from(store.emailThreadRefs.values()).filter(
        (row) => row.tenantId === tenantId && wanted.has(row.messageId),
      );
      // 1 件も無ければ null
      if (matches.length === 0) return null;
      // 最も新しく記録された対応を優先する (Prisma 実装の orderBy createdAt desc に揃える)
      matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      // 先頭 (最新) の ticketId を返す
      return matches[0].ticketId;
    },

    // Message-ID とチケットの対応を 1 件登録する (冪等)
    async register(input) {
      // 既に同じ (tenantId, messageId) があれば何もしない (Webhook 再送でも二重登録しない)
      const duplicated = Array.from(store.emailThreadRefs.values()).some(
        (row) => row.tenantId === input.tenantId && row.messageId === input.messageId,
      );
      if (duplicated) return;
      // 新規行を組み立てる (ID と記録日時はここで決定)
      const row: EmailThreadRefRow = {
        id: nextId(store, 'etr'), // 'etr_...' 形式の一意 ID
        messageId: input.messageId, // 正規化済み Message-ID
        ticketId: input.ticketId, // 紐づくチケット
        tenantId: input.tenantId, // 所属テナント
        createdAt: new Date(), // 現在時刻
      };
      // ストアに登録
      store.emailThreadRefs.set(row.id, row);
    },
  };
}
