// AI FAQ 自己解決の計測記録リポジトリ (port) のメモリ実装 (テスト用。§4.29)
import type { DeflectionEventRepository } from '@/data/ports/deflection-event-repository';
// ドメイン型
import type { DeflectionEvent } from '@/domain/types';
// メモリストアと連番 ID 生成
import { nextId, type Store } from './store';

// メモリストアを使った計測記録リポジトリを生成する関数
export function makeDeflectionEventRepo(store: Store): DeflectionEventRepository {
  return {
    // ID + tenantId で 1 件取得 (他テナントの ID なら null)
    async findById(id, tenantId) {
      const row = store.deflectionEvents.get(id); // Map から取得
      if (!row || row.tenantId !== tenantId) return null; // テナント不一致は null
      return { ...row }; // 破壊防止のため複製して返す
    },

    // 記録を新規作成してストアに登録
    async create(input) {
      // 現在時刻を createdAt/updatedAt に使用
      const now = new Date();
      // 新しい記録行を組み立てる (ticketId は起票に進むまで null)
      const row: DeflectionEvent = {
        id: nextId(store, 'dfl'), // 'dfl_...' 形式の一意 ID
        outcome: input.outcome,
        candidateCount: input.candidateCount,
        matchedFaqId: input.matchedFaqId,
        ticketId: null,
        model: input.model,
        userId: input.userId,
        tenantId: input.tenantId, // 所属テナントを必ず保存
        createdAt: now,
        updatedAt: now,
      };
      // ストアに登録
      store.deflectionEvents.set(row.id, row);
      // 作成結果を返す
      return { ...row };
    },

    // 決着状態を更新する (Prisma 実装と同じ CAS: テナント + 本人 + 期待状態が一致するときのみ)
    async updateOutcome(id, transition, scope, ticketId) {
      const row = store.deflectionEvents.get(id); // 更新対象を取得
      if (!row || row.tenantId !== scope.tenantId) return false; // 不在 or 他テナントなら何もしない
      if (row.userId !== scope.userId) return false; // 他人の記録は更新しない
      if (row.outcome !== transition.from) return false; // 期待状態と不一致 (競合) なら更新しない
      // 決着状態・チケット ID・更新日時を書き換えて保存
      store.deflectionEvents.set(id, {
        ...row,
        outcome: transition.to,
        ticketId,
        updatedAt: new Date(),
      });
      // 更新できたことを返す
      return true;
    },
  };
}
