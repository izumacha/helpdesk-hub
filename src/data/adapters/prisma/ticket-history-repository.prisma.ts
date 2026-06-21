// 履歴リポジトリの契約 (port) と Prisma 共通型をインポート
import type { TicketHistoryRepository } from '@/data/ports/ticket-history-repository';
import type { PrismaLike } from './types';

// 監査ログの取得件数上限 (パフォーマンス保護: 一覧で大量データを返さないようにする)
const AUDIT_MAX_LIMIT = 500;
// 取得件数の既定値 (一画面に収まる量)
const AUDIT_DEFAULT_LIMIT = 100;

// Prisma クライアントを使った履歴リポジトリを生成する関数
export function makeTicketHistoryRepo(db: PrismaLike): TicketHistoryRepository {
  return {
    // 履歴を 1 件記録する (戻り値なし)
    async record(input) {
      // TicketHistory テーブルに 1 行挿入
      await db.ticketHistory.create({
        data: {
          ticketId: input.ticketId, // 対象チケット
          changedById: input.changedById, // 変更者
          field: input.field, // 変更項目
          oldValue: input.oldValue, // 変更前
          newValue: input.newValue, // 変更後
        },
      });
    },

    // Phase 4: テナント全体の変更履歴を監査ログとして取得する
    // テナントスコープを必ず適用してクロステナント漏洩を防ぐ
    async findAllByTenant(filter) {
      // 件数上限を AUDIT_MAX_LIMIT でクランプ (DoS・リソース枯渇防止)
      const limit = Math.min(filter.limit ?? AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT);
      // スキップ件数 (ページネーション)
      const offset = filter.offset ?? 0;

      // チケット (件名) と変更者 (氏名) を eager-load して N+1 を回避する
      const rows = await db.ticketHistory.findMany({
        where: {
          // テナントスコープ: Ticket を通じて間接的に tenantId を絞り込む
          // TicketHistory に tenantId 列はないが、Ticket.tenantId でテナントを特定できる
          ticket: { tenantId: filter.tenantId },
        },
        // 表示に必要な関連レコードをまとめて取得 (N+1 回避)
        include: {
          ticket: { select: { title: true } }, // チケット件名のみ取得
          changedBy: { select: { name: true } }, // 変更者氏名のみ取得
        },
        orderBy: { createdAt: 'desc' }, // 新しい順に並べる
        take: limit, // 件数上限
        skip: offset, // ページネーション
      });

      // Prisma 行をドメイン型 (TicketHistoryWithRefs) に変換して返す
      return rows.map((row) => ({
        id: row.id, // 履歴 ID
        ticketId: row.ticketId, // 対象チケット ID
        ticketTitle: row.ticket.title, // チケット件名 (include で取得済み)
        changedById: row.changedById, // 変更者 ID
        changedByName: row.changedBy.name, // 変更者氏名 (include で取得済み)
        field: row.field, // 変更された項目
        oldValue: row.oldValue, // 変更前の値
        newValue: row.newValue, // 変更後の値
        createdAt: row.createdAt, // 変更日時
      }));
    },
  };
}
