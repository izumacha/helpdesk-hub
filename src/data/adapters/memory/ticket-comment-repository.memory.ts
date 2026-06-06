// コメントリポジトリの契約 (port) と、メモリストア/ID 生成ヘルパーをインポート
import type { TicketCommentRepository } from '@/data/ports/ticket-comment-repository';
import type { TicketComment } from '@/domain/types';
import { nextId, type Store } from './store';

// メモリストアを使ったコメントリポジトリを生成する関数
export function makeTicketCommentRepo(store: Store): TicketCommentRepository {
  return {
    // コメントを 1 件作成してストアに登録する
    async create(input) {
      // 親チケットが指定テナントに属することを検証する (issue #123)。
      // Prisma 実装と同じく、他テナントのチケットへのコメント付けを fail-closed で防ぐ。
      const parent = store.tickets.get(input.ticketId);
      // 親チケットが無い、または別テナントなら作成を拒否する
      if (!parent || parent.tenantId !== input.tenantId) {
        throw new Error('チケットが見つかりません');
      }
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
