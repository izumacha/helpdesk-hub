// E2E テストの後始末で使う共有ヘルパー。
// 監査ログ (SettingsAuditLog / TicketHistory / AuthAuditLog) は DB トリガで追記専用
// (prisma/migrations/20260726000100_add_audit_log_immutability) のため、テナントを
// 素朴に deleteMany すると FK カスケードが監査行の DELETE に到達して拒否される。
// このヘルパーは break-glass フラグ (SET LOCAL helpdesk.allow_audit_delete) を立てた
// トランザクション内で「監査行 → テナント」の順に削除する。break-glass はフラグに加えて
// 「スーパーユーザー or helpdesk_audit_admin ロール」の権限条件も要求するが、CI とローカルの
// テスト DB は postgres スーパーユーザーで接続するため満たされる。
// トリガが存在しない環境でもそのまま動作する (カスタム GUC の SET LOCAL は無害)。

// Prisma クライアント型 (テスト専用ヘルパーなので生成クライアントを直接受け取る)
import type { PrismaClient } from '../src/generated/prisma';

// 指定したテナント ID 群を、監査ログもろとも物理削除する (E2E 後始末専用)
export async function deleteTenantsForCleanup(
  prisma: PrismaClient,
  tenantIds: string[],
): Promise<void> {
  // 対象が無ければ何もしない
  if (tenantIds.length === 0) return;
  // 1 トランザクション内で順に実行する (SET LOCAL はトランザクション終了で自動失効する)
  await prisma.$transaction([
    // break-glass: このトランザクション内に限り監査ログの DELETE を許可する
    prisma.$executeRawUnsafe(`SET LOCAL helpdesk.allow_audit_delete = 'on'`),
    // User 削除カスケードの SET NULL (= 監査行への UPDATE。これは break-glass でも拒否される)
    // が発生する前に、対象テナントの監査行そのものを先に消しておく
    prisma.settingsAuditLog.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    // AuthAuditLog は FK を持たないためカスケードでは消えない。ここで明示的に消す
    prisma.authAuditLog.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    // 残るテーブル (User / Ticket / TicketHistory 等) は Tenant からの FK カスケードで消える
    prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }),
  ]);
}
