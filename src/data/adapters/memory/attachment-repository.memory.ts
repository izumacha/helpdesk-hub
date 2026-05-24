// 添付メタデータ用リポジトリのメモリ実装 (テスト用)。
// Prisma 実装と同じ tenantId スコープ振る舞いを再現する。

// Port 契約と関連型
import type { AttachmentRepository } from '@/data/ports/attachment-repository';
// ドメイン型
import type { Attachment } from '@/domain/attachment';
// メモリストアと ID 生成ヘルパー
import { nextId, type Store } from './store';

// メモリストアを使った添付リポジトリを生成する関数
export function makeAttachmentRepo(store: Store): AttachmentRepository {
  return {
    // 1 件作成してストアに登録 (ID と createdAt をここで採番)
    async create(input) {
      // 添付行を組み立てる
      const row: Attachment = {
        id: nextId(store, 'att'), // 'att_...' 形式の一意 ID
        ticketId: input.ticketId,
        commentId: input.commentId,
        uploaderId: input.uploaderId,
        tenantId: input.tenantId,
        mimeType: input.mimeType,
        size: input.size,
        originalName: input.originalName,
        storageKey: input.storageKey,
        storage: input.storage,
        createdAt: new Date(),
      };
      // ストアに登録 (ID をキーに格納)
      store.attachments.set(row.id, row);
      // 作成結果を呼び出し元に返す
      return row;
    },

    // ID + tenantId で 1 件取得 (他テナントの ID なら null)
    async findById(id, tenantId) {
      // ID で引いてからテナント一致を確認する
      const row = store.attachments.get(id);
      // 存在しない、または別テナントの行なら null を返す
      if (!row || row.tenantId !== tenantId) return null;
      // 一致すれば添付行を返す
      return row;
    },

    // チケット ID + tenantId で添付一覧を古い順に取得
    async listByTicket(ticketId, tenantId) {
      // 全添付を走査してチケット + テナント一致のみ抽出
      const rows: Attachment[] = [];
      for (const row of store.attachments.values()) {
        if (row.tenantId !== tenantId) continue; // 他テナントは除外
        if (row.ticketId !== ticketId) continue; // 対象チケット以外は除外
        rows.push(row);
      }
      // 作成日時の昇順に並べてから返す (古い順 = チケット詳細の自然な並び)
      rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return rows;
    },

    // チケット ID + tenantId で添付件数を返す (5 枚上限のチェック用)
    async countByTicket(ticketId, tenantId) {
      // 走査してカウントを増やす
      let count = 0;
      for (const row of store.attachments.values()) {
        if (row.tenantId !== tenantId) continue;
        if (row.ticketId !== ticketId) continue;
        count += 1;
      }
      return count;
    },

    // ID + tenantId で 1 件削除 (他テナントの ID は no-op)
    async delete(id, tenantId) {
      // 取り出してテナント一致のみ削除する
      const row = store.attachments.get(id);
      if (!row || row.tenantId !== tenantId) return; // 不一致なら何もしない
      store.attachments.delete(id);
    },
  };
}
