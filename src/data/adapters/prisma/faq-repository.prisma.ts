// FAQ リポジトリの契約 (port)、マッパー、Prisma 共通型をインポート
import {
  resolveFaqListLimit,
  type FaqListItem,
  type FaqRepository,
} from '@/data/ports/faq-repository';
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

    // 当該テナントの FAQ 候補一覧を取得 (新しい順、関連チケットと作成者を同梱)。
    // opts.limit で取得件数を上限化する (フォローアップ 2026-07-16 #3: §8 一覧取得の上限必須化)
    async list(tenantId, opts) {
      const rows = await db.faqCandidate.findMany({
        where: { tenantId }, // テナントスコープ (必須)
        orderBy: { createdAt: 'desc' }, // 新しい順
        take: resolveFaqListLimit(opts.limit), // 件数上限 (呼び出し元の指定値をさらにクランプ)
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
    // 元チケット/作成者は含めない範囲最小化のため select で question/answer のみに絞る)。
    // opts.limit で取得件数を上限化する (フォローアップ 2026-07-16 #3: §8 一覧取得の上限必須化)
    async listPublished(tenantId, opts) {
      // select の形が PublishedFaqItem と一致するため中間変数を使わずそのまま返す
      return db.faqCandidate.findMany({
        where: { tenantId, status: 'Published' }, // テナントスコープ + 公開済みのみ
        orderBy: { createdAt: 'desc' }, // 新しい順
        take: resolveFaqListLimit(opts.limit), // 件数上限 (呼び出し元の指定値をさらにクランプ)
        select: { id: true, question: true, answer: true }, // 質問/回答/IDのみ取得 (範囲最小化)
      });
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

    // 状態 (Candidate/Published/Rejected) を更新 (tenantId スコープ)。
    // where に期待する現在状態 (transition.from) を含めることで、読み取り後に別の操作が
    // 状態を変えていた場合は 0 件更新となり、禁止遷移 (例: Rejected→Published) が
    // 後勝ちで成立するのを DB 書き込み時点で防ぐ (フォローアップ 2026-07-15)
    async updateStatus(id, transition, tenantId) {
      // 条件付き一括更新 (ID + テナント + 期待状態がすべて一致した行だけ書き換える)
      const result = await db.faqCandidate.updateMany({
        where: { id, tenantId, status: transition.from }, // 期待状態が一致するときのみ更新
        data: { status: transition.to }, // 新しい状態へ書き換え
      });
      // 1 件以上更新できたか (0 件なら競合 or 不在 or 他テナント) を返す
      return result.count > 0;
    },

    // 質問/回答の本文を更新 (tenantId スコープ。他テナントの ID なら 0 件更新で no-op)
    async updateContent(id, content, tenantId) {
      await db.faqCandidate.updateMany({
        where: { id, tenantId }, // テナントスコープ (必須)
        data: { question: content.question, answer: content.answer }, // 質問/回答のみ書き換え
      });
    },
  };
}
