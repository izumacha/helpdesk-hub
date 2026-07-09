// Phase 2 フォローアップ: LINE 連携設定 (テナント単位) の変更 Server Action が共有する認可ゲート。
// docs/smb-dx-pivot-plan.md §4 Phase 2.1。SsoConfig の assertSsoConfigAdmin と同じ設計
// (「ログイン済み・admin・対象プラン」をまとめて検証し、実装ドリフトを防ぐ)。

// データ層の Composition Root (テナントのプラン確認に使う)
import { repos } from '@/data';
// LINE 連携機能のプランゲート (Pro / Enterprise のみ)
import { isLineIntegrationAllowed } from '@/lib/plan-guard';
// 「ログイン済み・admin・自テナント」の共通プリミティブ (sso-context.ts と共有)
import { assertTenantAdmin, type TenantAdminGate } from '@/lib/tenant-admin-gate';

// LINE 連携設定変更の前提検証結果。TenantAdminGate と全く同じ形状なので、
// 個別に再宣言せず型エイリアスにして将来のドリフト (片方だけ更新し忘れる) を防ぐ
export type LineConfigAdminGate = TenantAdminGate;

// LINE 連携設定変更の前提 (ログイン済み・admin・Pro/Enterprise プラン) をまとめて検証する。
export async function assertLineConfigAdmin(): Promise<LineConfigAdminGate> {
  // 共通プリミティブで「ログイン済み・admin・自テナント」を検証する
  const gate = await assertTenantAdmin();
  // 不通過ならその理由をそのまま返す
  if (!gate.ok) return gate;
  // テナントを取得してプランが LINE 連携を許可するか確認する (Pro / Enterprise のみ)
  const tenant = await repos.tenants.findById(gate.tenantId);
  if (!tenant) return { ok: false, error: 'テナント情報の取得に失敗しました' };
  if (!isLineIntegrationAllowed(tenant.subscriptionPlan)) {
    return { ok: false, error: 'LINE 連携は Pro / Enterprise プランでのみ利用できます。' };
  }
  // すべて満たしたので tenantId / userId を返す
  return { ok: true, tenantId: gate.tenantId, userId: gate.userId };
}

// LINE 連携設定の削除専用ゲート: 「ログイン済み・admin・自テナント」のみを検証し、
// プランチェックは行わない。プラン降格後に既存設定が削除できなくなる不具合を防ぐため
// (assertLineConfigAdmin は新規作成/更新など「これから LINE 連携を使う」操作向けのゲートで、
// 「もう使わない設定を消す」削除操作には本来不要なプラン要件まで課してしまっていた)。
export async function assertLineConfigOwner(): Promise<LineConfigAdminGate> {
  // プランチェックが不要な分、共通プリミティブの結果をそのまま返す
  return assertTenantAdmin();
}
