// コメントリポジトリの契約 (port)、マッパー、Prisma 共通型をインポート
import type { TicketCommentRepository } from '@/data/ports/ticket-comment-repository';
import { toComment } from './mappers';
import type { PrismaLike } from './types';

// Prisma クライアントを使ったコメントリポジトリを生成する関数
export function makeTicketCommentRepo(db: PrismaLike): TicketCommentRepository {
  return {
    // コメントを 1 件作成して、ドメイン型で返す
    async create(input) {
      // 親チケットが指定テナントに属することを検証する (issue #123)。
      // 呼び出し側が tenant スコープの取得を忘れても、他テナントのチケットへは
      // コメントを付けられないよう Adapter 側で fail-closed にする。
      const parent = await db.ticket.findFirst({
        where: { id: input.ticketId, tenantId: input.tenantId }, // チケット ID + テナントの AND 一致
        select: { id: true }, // 存在確認だけなので id のみ取得
      });
      // 親チケットが無い (= 別テナント or 不在) なら作成を拒否する
      if (!parent) {
        throw new Error('チケットが見つかりません');
      }
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
