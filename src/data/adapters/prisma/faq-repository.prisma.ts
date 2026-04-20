// FAQ リポジトリの契約 (port)、マッパー、Prisma 共通型をインポート
import type { FaqListItem, FaqRepository } from '@/data/ports/faq-repository';
import { toFaq } from './mappers';
import type { PrismaLike } from './types';

// Prisma クライアントを使った FAQ リポジトリを生成する関数
export function makeFaqRepo(db: PrismaLike): FaqRepository {
  return {
    // ID で 1 件取得してドメイン型に変換
    async findById(id) {
      const row = await db.faqCandidate.findUnique({ where: { id } });
      return row ? toFaq(row) : null;
    },

    // 一覧取得 (新しい順、関連チケットと作成者を同梱)
    async list() {
      const rows = await db.faqCandidate.findMany({
        orderBy: { createdAt: 'desc' }, // 新しい順
        include: {
          // 関連チケットの最小情報を JOIN
          ticket: { select: { id: true, title: true } },
          // 作成者の名前だけを JOIN
          createdBy: { select: { name: true } },
        },
      });
      // 各行を FaqListItem 形式に整形
      return rows.map<FaqListItem>((f) => ({
        ...toFaq(f), // 本体はドメイン型に変換
        ticket: { id: f.ticket.id, title: f.ticket.title },
        createdBy: { name: f.createdBy.name },
      }));
    },

    // 新規 FAQ 候補を作成 (ステータスは DB 側デフォルトで Candidate)
    async create(input) {
      const row = await db.faqCandidate.create({
        data: {
          ticketId: input.ticketId,
          createdById: input.createdById,
          question: input.question,
          answer: input.answer,
        },
      });
      // 作成結果をドメイン型に変換して返す
      return toFaq(row);
    },

    // 状態 (Candidate/Published/Rejected) を更新
    async updateStatus(id, status) {
      await db.faqCandidate.update({ where: { id }, data: { status } });
    },
  };
}
