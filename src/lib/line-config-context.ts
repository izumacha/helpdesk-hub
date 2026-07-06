// Phase 2 フォローアップ: LINE 連携設定 (テナント単位) の変更 Server Action が共有する認可ゲート。
// docs/smb-dx-pivot-plan.md §4 Phase 2.1。SsoConfig の assertSsoConfigAdmin と同じ設計
// (「ログイン済み・admin・対象プラン」をまとめて検証し、実装ドリフトを防ぐ)。

// 現在のセッション取得
import { auth } from '@/lib/auth';
// データ層の Composition Root (テナントのプラン確認に使う)
import { repos } from '@/data';
// LINE 連携機能のプランゲート (Pro / Enterprise のみ)
import { isLineIntegrationAllowed } from '@/lib/plan-guard';

// LINE 連携設定変更の前提検証結果
export type LineConfigAdminGate = { ok: true; tenantId: string } | { ok: false; error: string };

// LINE 連携設定変更の前提 (ログイン済み・admin・Pro/Enterprise プラン) をまとめて検証する。
export async function assertLineConfigAdmin(): Promise<LineConfigAdminGate> {
  // セッション取得と認証チェック
  const session = await auth();
  // 未ログインまたは tenantId 不在は拒否
  if (!session?.user?.id || !session.user.tenantId) {
    return { ok: false, error: '認証が必要です' };
  }
  // 管理者以外は設定変更不可 (UI 非表示に頼らずサーバー側で強制)
  if (session.user.role !== 'admin') {
    return { ok: false, error: 'この操作は管理者のみ実行できます' };
  }
  // セッション由来の tenantId のみ使う (クロステナント設定防止)
  const tenantId = session.user.tenantId;
  // テナントを取得してプランが LINE 連携を許可するか確認する (Pro / Enterprise のみ)
  const tenant = await repos.tenants.findById(tenantId);
  if (!tenant) return { ok: false, error: 'テナント情報の取得に失敗しました' };
  if (!isLineIntegrationAllowed(tenant.subscriptionPlan)) {
    return { ok: false, error: 'LINE 連携は Pro / Enterprise プランでのみ利用できます。' };
  }
  // すべて満たしたので tenantId を返す
  return { ok: true, tenantId };
}
