// FAQ リポジトリの契約 (port) と、ドメイン型/ストア関連をインポート
import type { FaqListItem, FaqRepository } from '@/data/ports/faq-repository';
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

    // 当該テナントの FAQ 候補を新しい順で一覧化 (関連チケット/作成者名を結合)
    async list(tenantId) {
      // Map を配列化し、テナントで絞ったうえで作成日時の降順で並べる
      const rows = [...store.faq.values()]
        .filter((f) => f.tenantId === tenantId)
        .sort((a, b) => +b.createdAt - +a.createdAt);
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

    // FAQ 候補の状態を更新 (tenantId スコープ。テナント不一致なら no-op)
    async updateStatus(id, status, tenantId) {
      const row = store.faq.get(id); // 更新対象を取得
      if (!row || row.tenantId !== tenantId) return; // 不在 or 他テナントなら何もしない
      // 状態と更新日時を書き換えて保存
      store.faq.set(id, { ...row, status, updatedAt: new Date() });
    },
  };
}
