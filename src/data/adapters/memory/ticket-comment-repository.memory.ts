// コメントリポジトリの契約 (port) と、メモリストア/ID 生成ヘルパーをインポート
import type { TicketCommentRepository } from '@/data/ports/ticket-comment-repository';
import type { TicketComment } from '@/domain/types';
import { nextId, type Store } from './store';

// メモリストアを使ったコメントリポジトリを生成する関数
export function makeTicketCommentRepo(store: Store): TicketCommentRepository {
  return {
    // コメントを 1 件作成してストアに登録する
    async create(input) {
      // 作成用オブジェクトを組み立てる (ID と作成日時をここで決定)
      const row: TicketComment = {
        id: nextId(store, 'cmt'), // 'cmt_...' 形式の一意 ID
        ticketId: input.ticketId, // 対象チケット
        authorId: input.authorId, // 書き込みユーザー
        body: input.body, // コメント本文
        createdAt: new Date(), // 現在時刻
      };
      // ストアに登録
      store.comments.set(row.id, row);
      // 作成結果を呼び出し元に返す
      return row;
    },
  };
}
