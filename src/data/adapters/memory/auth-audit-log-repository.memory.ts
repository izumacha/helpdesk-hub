// 認証イベント監査ログリポジトリの契約 (port) と、メモリストア/ID 生成ヘルパーをインポート
import type { AuthAuditLogRepository } from '@/data/ports/auth-audit-log-repository';
import type { AuthAuditLog } from '@/domain/types';
import { nextId, type Store } from './store';

// メモリストアを使った認証イベント監査ログリポジトリを生成する関数 (テスト用)
export function makeAuthAuditLogRepo(store: Store): AuthAuditLogRepository {
  return {
    // 認証イベントを 1 件記録する
    async record(input) {
      // 新しい監査ログ行を組み立てる
      const row: AuthAuditLog = {
        id: nextId(store, 'aal'), // 'aal_...' 形式の一意 ID
        event: input.event, // 認証イベントの種別
        email: input.email, // 試行対象メール (小文字正規化済み)
        userId: input.userId, // 対応ユーザー ID (不在なら null)
        tenantId: input.tenantId, // 所属テナント ID (不在なら null)
        createdAt: new Date(), // 記録日時
      };
      // ストアに登録する (Prisma 実装と同じく戻り値はなし)
      store.authAuditLogs.set(row.id, row);
    },
  };
}
