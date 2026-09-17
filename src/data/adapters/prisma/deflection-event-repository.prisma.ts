// AI FAQ 自己解決の計測記録リポジトリ (port) の Prisma 実装 (§4.29)
import type { DeflectionEventRepository } from '@/data/ports/deflection-event-repository';
// Prisma 行 → ドメイン型のマッパー
import { toDeflectionEvent } from './mappers';
// Prisma クライアント/トランザクション共通型
import type { PrismaLike } from './types';

// Prisma クライアントを使った計測記録リポジトリを生成する関数
export function makeDeflectionEventRepo(db: PrismaLike): DeflectionEventRepository {
  return {
    // ID + tenantId で 1 件取得 (他テナントの ID なら null)
    async findById(id, tenantId) {
      // テナントスコープ付きで 1 件検索する
      const row = await db.deflectionEvent.findFirst({ where: { id, tenantId } });
      // 見つかればドメイン型に変換し、無ければ null
      return row ? toDeflectionEvent(row) : null;
    },

    // 記録を新規作成する (tenantId を必ず保存)
    async create(input) {
      // 入力値をそのまま列に写して INSERT する
      const row = await db.deflectionEvent.create({
        data: {
          tenantId: input.tenantId, // 所属テナント (必須)
          userId: input.userId,
          outcome: input.outcome,
          candidateCount: input.candidateCount,
          matchedFaqId: input.matchedFaqId,
          model: input.model,
        },
      });
      // 作成結果をドメイン型に変換して返す
      return toDeflectionEvent(row);
    },

    // 決着状態を CAS (期待する現在状態 + テナント + 本人) 付きで更新する
    async updateOutcome(id, transition, scope, ticketId) {
      // 条件付き一括更新 (ID + テナント + 本人 + 期待状態がすべて一致した行だけ書き換える)
      const result = await db.deflectionEvent.updateMany({
        where: {
          id,
          tenantId: scope.tenantId, // テナントスコープ (必須)
          userId: scope.userId, // 本人の記録だけを更新できる (他人の記録の改ざん防止)
          outcome: transition.from, // 期待状態 (suggested) が一致するときのみ更新
        },
        data: { outcome: transition.to, ticketId }, // 決着状態と (起票時の) チケット ID を書き換え
      });
      // 1 件以上更新できたか (0 件なら競合 or 不在 or 他テナント/他人) を返す
      return result.count > 0;
    },
  };
}
