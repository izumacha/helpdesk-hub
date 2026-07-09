// 設定変更監査ログリポジトリの契約 (port) と Prisma 共通型をインポート
import type { SettingsAuditLogRepository } from '@/data/ports/settings-audit-log-repository';
import type { PrismaLike } from './types';

// 監査ログの取得件数上限 (パフォーマンス保護: 一覧で大量データを返さないようにする。
// ticket-history-repository.prisma.ts と同じ上限値に揃える)
const AUDIT_MAX_LIMIT = 500;
// 取得件数の既定値 (一画面に収まる量)
const AUDIT_DEFAULT_LIMIT = 100;

// Prisma クライアントを使った設定変更監査ログリポジトリを生成する関数
export function makeSettingsAuditLogRepo(db: PrismaLike): SettingsAuditLogRepository {
  return {
    // 監査ログを 1 件記録する (戻り値なし)
    async record(input) {
      // SettingsAuditLog テーブルに 1 行挿入
      await db.settingsAuditLog.create({
        data: {
          tenantId: input.tenantId, // 対象テナント
          actorId: input.actorId, // 操作者
          action: input.action, // 実行された操作の種別
        },
      });
    },

    // テナント全体の設定変更監査ログを取得する
    // テナントスコープを必ず適用してクロステナント漏洩を防ぐ
    async findAllByTenant(filter) {
      // 件数上限を AUDIT_MAX_LIMIT でクランプ (DoS・リソース枯渇防止)
      const limit = Math.min(filter.limit ?? AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT);
      // スキップ件数 (ページネーション)
      const offset = filter.offset ?? 0;

      // 操作者 (氏名) を eager-load して N+1 を回避する
      const rows = await db.settingsAuditLog.findMany({
        where: { tenantId: filter.tenantId }, // テナントスコープ
        include: {
          actor: { select: { name: true } }, // 操作者氏名のみ取得
        },
        orderBy: { createdAt: 'desc' }, // 新しい順に並べる
        take: limit, // 件数上限
        skip: offset, // ページネーション
      });

      // Prisma 行をドメイン型 (SettingsAuditLogWithRefs) に変換して返す
      return rows.map((row) => ({
        id: row.id, // 監査ログ ID
        actorId: row.actorId, // 操作者 ID
        actorName: row.actor.name, // 操作者氏名 (include で取得済み)
        action: row.action, // 実行された操作の種別
        createdAt: row.createdAt, // 操作日時
      }));
    },
  };
}
