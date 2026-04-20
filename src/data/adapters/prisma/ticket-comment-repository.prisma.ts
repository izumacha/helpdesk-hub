// コメントリポジトリの契約 (port)、マッパー、Prisma 共通型をインポート
import type { TicketCommentRepository } from '@/data/ports/ticket-comment-repository';
import { toComment } from './mappers';
import type { PrismaLike } from './types';

// Prisma クライアントを使ったコメントリポジトリを生成する関数
export function makeTicketCommentRepo(db: PrismaLike): TicketCommentRepository {
  return {
    // コメントを 1 件作成して、ドメイン型で返す
    async create(input) {
      const row = await db.ticketComment.create({
        data: {
          ticketId: input.ticketId, // 対象チケット
          authorId: input.authorId, // 書き込みユーザー
          body: input.body, // コメント本文
        },
      });
      // Prisma 行をドメイン型 TicketComment に変換して返す
      return toComment(row);
    },
  };
}
