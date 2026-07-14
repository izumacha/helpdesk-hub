// FAQ リポジトリの契約 (port)、マッパー、Prisma 共通型をインポート
import type { FaqListItem, FaqRepository } from '@/data/ports/faq-repository';
import { toFaq } from './mappers';
import type { PrismaLike } from './types';

// Prisma クライアントを使った FAQ リポジトリを生成する関数
export function makeFaqRepo(db: PrismaLike): FaqRepository {
  return {
    // ID + tenantId で 1 件取得 (他テナントの ID なら null)
    async findById(id, tenantId) {
      const row = await db.faqCandidate.findFirst({ where: { id, tenantId } });
      return row ? toFaq(row) : null;
    },

    // 当該テナントの FAQ 候補一覧を取得 (新しい順、関連チケットと作成者を同梱)
    async list(tenantId) {
      const rows = await db.faqCandidate.findMany({
        where: { tenantId }, // テナントスコープ (必須)
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

    // 当該テナントの公開済み (Published) FAQ 一覧を取得 (依頼者含む全メンバー向け。
    // 元チケット/作成者は含めない範囲最小化のため select で question/answer のみに絞る)
    async listPublished(tenantId) {
      const rows = await db.faqCandidate.findMany({
        where: { tenantId, status: 'Published' }, // テナントスコープ + 公開済みのみ
        orderBy: { createdAt: 'desc' }, // 新しい順
        select: { id: true, question: true, answer: true },
      });
      return rows;
    },

    // 新規 FAQ 候補を作成 (ステータスは DB 側デフォルトで Candidate)
    async create(input) {
      const row = await db.faqCandidate.create({
        data: {
          ticketId: input.ticketId,
          createdById: input.createdById,
          question: input.question,
          answer: input.answer,
          tenantId: input.tenantId, // 所属テナントを必ず保存
        },
      });
      // 作成結果をドメイン型に変換して返す
      return toFaq(row);
    },

    // 状態 (Candidate/Published/Rejected) を更新 (tenantId スコープ)
    async updateStatus(id, status, tenantId) {
      await db.faqCandidate.updateMany({ where: { id, tenantId }, data: { status } });
    },
  };
}
