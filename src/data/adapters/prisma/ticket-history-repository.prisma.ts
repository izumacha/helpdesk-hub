// 履歴リポジトリの契約 (port) と Prisma 共通型をインポート
import type { TicketHistoryRepository } from '@/data/ports/ticket-history-repository';
import type { PrismaLike } from './types';
// 監査ログ系リポジトリ共通のページネーション上限・クランプ処理 (settings-audit-log-repository と共有)
import { resolveAuditLimit } from '../audit-pagination';

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
      // 件数上限をクランプ (DoS・リソース枯渇防止)
      const limit = resolveAuditLimit(filter.limit);
      // スキップ件数 (ページネーション)
      const offset = filter.offset ?? 0;

      // チケット (件名) と変更者 (氏名) を eager-load して N+1 を回避する
      const rows = await db.ticketHistory.findMany({
        where: {
          // テナントスコープ: Ticket を通じて間接的に tenantId を絞り込む
          // TicketHistory に tenantId 列はないが、Ticket.tenantId でテナントを特定できる
          ticket: { tenantId: filter.tenantId },
          // §4.2.1 フォローアップ再訪: before が指定されていれば「それより前」の行だけに絞る
          // (複合キーセットカーソル)。この TicketHistory 側は自身の kind が 'ticket'。
          // /code-review ultra 再指摘対応: TicketHistory と SettingsAuditLog という由来の
          // 異なる 2 テーブルをマージするため、cursor.kind によって条件を分ける必要がある
          // (マージ順序は 'ticket' が 'settings' より先。AuditPaginationCursor のコメント参照)。
          // - cursor.kind === 'ticket' (自分と同じテーブル由来): 通常どおり id をタイブレーカーにする
          // - cursor.kind === 'settings' (別テーブル由来): cursor の createdAt 時点で 'ticket' 側は
          //   マージ順序上すでに全件表示済みのはずなので、同時刻の行は id に関わらず全て除外する
          //   (createdAt < before.createdAt だけで足りる。他方をそのまま流用すると、まだ
          //   1 件も表示していない SettingsAuditLog 側の行を誤って除外する回帰が起きていた)
          ...(filter.before &&
            (filter.before.kind === 'ticket'
              ? {
                  OR: [
                    { createdAt: { lt: filter.before.createdAt } },
                    { createdAt: filter.before.createdAt, id: { lt: filter.before.id } },
                  ],
                }
              : { createdAt: { lt: filter.before.createdAt } })),
        },
        // 表示に必要な関連レコードをまとめて取得 (N+1 回避)
        include: {
          ticket: { select: { title: true } }, // チケット件名のみ取得
          changedBy: { select: { name: true } }, // 変更者氏名のみ取得
        },
        // 新しい順に並べる。createdAt が同値の行を安定した順序にするため id を第 2 キーにする
        // (§4.2.1 フォローアップ再訪: before カーソルの比較条件と対になる)
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
