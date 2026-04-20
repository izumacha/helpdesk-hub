// ドメイン型 (コメント) をインポート
import type { TicketComment } from '@/domain/types';

// コメント作成時に渡す入力値
export interface CreateCommentInput {
  ticketId: string; // 対象チケット ID
  authorId: string; // 書き込みユーザー ID
  body: string; // コメント本文
}

// コメント書き込み用リポジトリの契約 (port)
export interface TicketCommentRepository {
  create(input: CreateCommentInput): Promise<TicketComment>; // 1 件作成し、作成結果を返す
}
