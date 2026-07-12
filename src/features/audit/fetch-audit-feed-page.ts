// 監査ログ画面 (/audit) と CSV 全履歴エクスポート (GET /api/audit/export) が共有する
// 「TicketHistory + SettingsAuditLog を 1 ページ分取得してマージする」ロジック。
//
// §4.2.1 フォローアップ再訪 (2026-07-12): 当初このロジックは audit/page.tsx に直書きされて
// いたが、全履歴 CSV エクスポート (現在表示中のページ分のみに限定されていたギャップの解消)
// を追加するにあたり、ページ表示側とエクスポート側の双方が同じマージ・カーソル前進ロジックを
// 必要とするため、単一の関数に抽出した (CLAUDE.md §6 DRY: 2 箇所目の複製が生じる前に共通化)。

// データ層の Composition Root (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 監査ログ一覧が扱う統一行型 (チケット変更履歴 + 設定変更監査ログ)
import type { AuditFeedRow } from '@/features/audit/types';
// キーセットページネーションのカーソル型 (2 リポジトリ共通)
import type { AuditPaginationCursor } from '@/data/ports/audit-pagination';

// 1 ページ分の取得結果
export interface AuditFeedPage {
  logs: AuditFeedRow[]; // マージ・ソート済みの行 (最大 limit 件)
  hasMore: boolean; // まだ表示していない古い行が残っている可能性があるか
  nextCursor: AuditPaginationCursor | null; // 「さらに読み込む」用の次カーソル (hasMore が false なら null)
}

/**
 * TicketHistory / SettingsAuditLog を並列取得し、統一行型にマージして新しい順に並べ、
 * limit 件に絞った 1 ページ分を返す。
 *
 * @param tenantId セッション由来のテナント ID (クロステナント漏洩防止のため必須)
 * @param limit このページで取得する最大件数
 * @param before キーセットページネーションのカーソル (未指定なら最新から)
 */
export async function fetchAuditFeedPage(
  tenantId: string,
  limit: number,
  before?: AuditPaginationCursor,
): Promise<AuditFeedPage> {
  // 2 種類の時系列をマージ表示する都合上、offset だけでは正しくページ送りできないため
  // (findAllByTenant のコメント参照)、双方に同じ createdAt/kind/id 境界を渡す方式に統一している
  const [ticketHistory, settingsAudit] = await Promise.all([
    repos.history.findAllByTenant({ tenantId, limit, before }),
    repos.settingsAudit.findAllByTenant({ tenantId, limit, before }),
  ]);

  // 両者を共通の行型 (AuditFeedRow) に変換してマージし、新しい順に並べて limit 件に絞る
  const logs: AuditFeedRow[] = [
    ...ticketHistory.map(
      (h): AuditFeedRow => ({
        kind: 'ticket',
        id: h.id,
        createdAt: h.createdAt,
        actorName: h.changedByName,
        ticketId: h.ticketId,
        ticketTitle: h.ticketTitle,
        field: h.field,
        oldValue: h.oldValue,
        newValue: h.newValue,
      }),
    ),
    ...settingsAudit.map(
      (s): AuditFeedRow => ({
        kind: 'settings',
        id: s.id,
        createdAt: s.createdAt,
        actorName: s.actorName,
        action: s.action,
      }),
    ),
  ]
    .sort((a, b) => {
      // 日時が異なればそれだけで決まる (新しい順)
      const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
      if (timeDiff !== 0) return timeDiff;
      // 同時刻のタイブレークを Array.sort の安定性 + 配列の連結順序という暗黙の前提に頼ると、
      // 将来の並び替え・データソース追加で静かに壊れる。findAllByTenant 側の
      // isBeforeAuditCursor / Prisma クエリと同じ「ticket が settings より先」という
      // 規約を、ここでも明示的なコードとして固定する (AuditPaginationCursor 参照)
      if (a.kind !== b.kind) return a.kind === 'ticket' ? -1 : 1;
      // 同 kind 内は id 降順 (各リポジトリの取得順・カーソル比較と一致させる)
      return a.id < b.id ? 1 : -1;
    })
    .slice(0, limit);

  // このページがちょうど limit 件で埋まっていれば、まだ表示していない古い行が残っている
  // 可能性があるとみなす (簡易ヒューリスティック。ちょうど境界と一致すると 1 回余分に
  // 次ページを取りに行くだけで実害は無い)
  const hasMore = logs.length === limit;
  // 「さらに読み込む」/ 次ページ取得用の次カーソル = このページで最も古い行の (日時, kind, id)
  const oldestLog = hasMore ? logs[logs.length - 1] : null;
  const nextCursor: AuditPaginationCursor | null = oldestLog
    ? { createdAt: oldestLog.createdAt, kind: oldestLog.kind, id: oldestLog.id }
    : null;

  return { logs, hasMore, nextCursor };
}
