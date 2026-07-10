// 設定変更監査ログリポジトリの契約 (port) と Prisma 共通型をインポート
import type { SettingsAuditLogRepository } from '@/data/ports/settings-audit-log-repository';
import type { PrismaLike } from './types';
// 監査ログ系リポジトリ共通のページネーション上限・クランプ処理 (ticket-history-repository と共有)
import { resolveAuditLimit } from '../audit-pagination';
// actorId が null (システムによる自動変更) のときに表示する操作者名の一元管理定数
import { SETTINGS_AUDIT_SYSTEM_ACTOR_NAME } from '@/lib/constants';

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
      // 件数上限をクランプ (DoS・リソース枯渇防止)
      const limit = resolveAuditLimit(filter.limit);
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

      // Prisma 行をドメイン型 (SettingsAuditLogWithRefs) に変換して返す。
      // actorId が null (§4.3 フォローアップ: Stripe Webhook 起因の自動プランダウングレード等) の
      // 場合、include の actor リレーションも null になるため固定ラベルへ解決する
      return rows.map((row) => ({
        id: row.id, // 監査ログ ID
        actorId: row.actorId, // 操作者 ID (null ならシステム操作)
        actorName: row.actor?.name ?? SETTINGS_AUDIT_SYSTEM_ACTOR_NAME, // 操作者氏名
        action: row.action, // 実行された操作の種別
        createdAt: row.createdAt, // 操作日時
      }));
    },
  };
}
