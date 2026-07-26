// 認証イベント監査ログリポジトリの契約 (port) と Prisma 共通型をインポート
import type { AuthAuditLogRepository } from '@/data/ports/auth-audit-log-repository';
import type { PrismaLike } from './types';

// Prisma クライアントを使った認証イベント監査ログリポジトリを生成する関数
export function makeAuthAuditLogRepo(db: PrismaLike): AuthAuditLogRepository {
  return {
    // 認証イベントを 1 件記録する (戻り値なし)。
    // AuthAuditLog テーブルは DB トリガで UPDATE/DELETE を禁止した追記専用テーブル
    // (prisma/migrations/20260726000100_add_audit_log_immutability)
    async record(input) {
      // AuthAuditLog テーブルに 1 行挿入する
      await db.authAuditLog.create({
        data: {
          event: input.event, // 認証イベントの種別
          email: input.email, // 試行対象メール (小文字正規化済み)
          userId: input.userId, // 対応ユーザー ID (不在なら null)
          tenantId: input.tenantId, // 所属テナント ID (不在なら null)
        },
      });
    },
  };
}
