// 「ログイン済み・admin・自テナント」だけを検証する共通プリミティブ。
// LINE/SSO 連携設定の各種認可ゲート (line-config-context.ts / sso-context.ts) が、
// 機能固有のプランチェック (isLineIntegrationAllowed 等) を足す/足さないかだけが異なる
// 同じ「認証+ロール」ブロックを個別に複製していたため、その共通部分だけを 1 か所に集約する。
// プランチェックは機能ごとに異なる (あるいは削除ゲートのように不要な) ため、ここでは行わない。

// 現在のセッション取得
import { auth } from '@/lib/auth';

// テナント管理者ゲートの検証結果 (userId は §4.2 監査ログ記録で「誰が」を残すために使う)
export type TenantAdminGate =
  | { ok: true; tenantId: string; userId: string }
  | { ok: false; error: string };

// 「ログイン済み・admin・自テナント」をまとめて検証する。プランは問わない
export async function assertTenantAdmin(): Promise<TenantAdminGate> {
  // セッション取得と認証チェック
  const session = await auth();
  // 未ログインまたは tenantId 不在は拒否
  if (!session?.user?.id || !session.user.tenantId) {
    return { ok: false, error: '認証が必要です' };
  }
  // 管理者以外は操作不可 (UI 非表示に頼らずサーバー側で強制)
  if (session.user.role !== 'admin') {
    return { ok: false, error: 'この操作は管理者のみ実行できます' };
  }
  // セッション由来の tenantId / userId を返す (クロステナント操作防止・監査ログの操作者記録に使う)
  return { ok: true, tenantId: session.user.tenantId, userId: session.user.id };
}
