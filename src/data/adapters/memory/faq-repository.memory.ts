// FAQ リポジトリの契約 (port) と、ドメイン型/ストア関連をインポート
import {
  resolveFaqListLimit,
  type FaqListItem,
  type FaqRepository,
} from '@/data/ports/faq-repository';
import type { FaqCandidate } from '@/domain/types';
import { nextId, type Store } from './store';

// メモリストアを使った FAQ リポジトリを生成する関数
export function makeFaqRepo(store: Store): FaqRepository {
  return {
    // ID + tenantId で 1 件取得 (他テナントの ID なら null)
    async findById(id, tenantId) {
      const row = store.faq.get(id); // Map から取得
      if (!row || row.tenantId !== tenantId) return null; // テナント不一致は null
      return { ...row }; // 破壊防止のため複製して返す
    },

    // 当該テナントの FAQ 候補を新しい順で一覧化 (関連チケット/作成者名を結合)。
    // opts.limit で取得件数を上限化する (フォローアップ 2026-07-16 #3: §8 一覧取得の上限必須化)
    async list(tenantId, opts) {
      // Map を配列化し、テナントで絞ったうえで作成日時の降順で並べ、上限件数で切り詰める
      const rows = [...store.faq.values()]
        .filter((f) => f.tenantId === tenantId)
        .sort((a, b) => +b.createdAt - +a.createdAt)
        .slice(0, resolveFaqListLimit(opts.limit)); // 呼び出し元の指定値をさらにクランプ
      // 関連チケットと作成者を引き当てて結合
      return rows.map<FaqListItem>((f) => {
        const ticket = store.tickets.get(f.ticketId); // 元チケット
        const createdBy = store.users.get(f.createdById); // 作成者
        // 整合性チェック: ないはずのデータが欠けていれば例外
        if (!ticket) throw new Error(`memory adapter: ticket ${f.ticketId} missing`);
        if (!createdBy) throw new Error(`memory adapter: user ${f.createdById} missing`);
        // FAQ 候補に関連情報を結合して返す
        return {
          ...f,
          ticket: { id: ticket.id, title: ticket.title },
          createdBy: { name: createdBy.name },
        };
      });
    },

    // 当該テナントの公開済み (Published) FAQ を新しい順で一覧化 (依頼者含む全メンバー向け。
    // 元チケット/作成者は含めない範囲最小化のため質問/回答のみ返す)。
    // opts.limit で取得件数を上限化する (フォローアップ 2026-07-16 #3: §8 一覧取得の上限必須化)
    async listPublished(tenantId, opts) {
      return [...store.faq.values()]
        .filter((f) => f.tenantId === tenantId && f.status === 'Published')
        .sort((a, b) => +b.createdAt - +a.createdAt)
        .slice(0, resolveFaqListLimit(opts.limit)) // 呼び出し元の指定値をさらにクランプ
        .map((f) => ({ id: f.id, question: f.question, answer: f.answer }));
    },

    // 新規 FAQ 候補を作成してストアに登録
    async create(input) {
      // 現在時刻を createdAt/updatedAt に使用
      const now = new Date();
      // 新しい FAQ 候補行を組み立て (状態は Candidate 固定で開始)
      const row: FaqCandidate = {
        id: nextId(store, 'faq'), // 'faq_...' 形式の一意 ID
        ticketId: input.ticketId,
        createdById: input.createdById,
        question: input.question,
        answer: input.answer,
        status: 'Candidate',
        createdAt: now,
        updatedAt: now,
        tenantId: input.tenantId, // 所属テナントを必ず保存
      };
      // ストアに登録
      store.faq.set(row.id, row);
      // 作成結果を返す
      return row;
    },

    // FAQ 候補の状態を更新 (tenantId スコープ。テナント不一致なら no-op)。
    // Prisma アダプタと同じく期待する現在状態 (transition.from) が一致するときだけ更新し、
    // 一致しなければ false を返す (check-then-act 競合の防止。フォローアップ 2026-07-15)
    async updateStatus(id, transition, tenantId) {
      const row = store.faq.get(id); // 更新対象を取得
      if (!row || row.tenantId !== tenantId) return false; // 不在 or 他テナントなら何もしない
      if (row.status !== transition.from) return false; // 期待状態と不一致 (競合) なら更新しない
      // 状態と更新日時を書き換えて保存
      store.faq.set(id, { ...row, status: transition.to, updatedAt: new Date() });
      // 更新できたことを返す
      return true;
    },

    // 質問/回答の本文を更新 (tenantId スコープ。テナント不一致なら no-op)
    async updateContent(id, content, tenantId) {
      const row = store.faq.get(id); // 更新対象を取得
      if (!row || row.tenantId !== tenantId) return; // 不在 or 他テナントなら何もしない
      // 質問/回答と更新日時を書き換えて保存
      store.faq.set(id, {
        ...row,
        question: content.question,
        answer: content.answer,
        updatedAt: new Date(),
      });
    },
  };
}
