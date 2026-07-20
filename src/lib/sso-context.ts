// Phase 4 Enterprise: SSO ルート (login / acs) が共通で使う「SSO 有効性チェック」。
// docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」。
//
// テナントの存在・プラン (Enterprise)・SSO 設定の有無・有効フラグをまとめて検証し、
// すべて満たすときだけ SAML SP 構築に必要な情報を返す (fail-closed)。
// いずれかの条件を欠く場合は理由付きで失敗を返し、呼び出し側がエラーリダイレクトに変換する。

// データ層の Composition Root
import { repos } from '@/data';
// プラン別の SSO 可否ゲート (Enterprise のみ)
import { isSsoAllowed } from '@/lib/plan-guard';
// アプリの公開ベース URL を解決するヘルパー
import { resolveAppBaseUrl } from '@/lib/app-url';
// 「ログイン済み・admin・自テナント」の共通プリミティブ (line-config-context.ts と共有)
import { assertTenantAdmin, type TenantAdminGate } from '@/lib/tenant-admin-gate';
// ドメイン型
import type { Tenant, TenantSsoConfig } from '@/domain/types';

// SSO コンテキストの取得結果 (成功 or 失敗理由つき)
export type SsoContextResult =
  | { ok: true; tenant: Tenant; config: TenantSsoConfig; baseUrl: string }
  | { ok: false; reason: 'not-found' | 'plan' | 'config' | 'disabled' };

// テナントの SSO ログインが利用可能かを検証し、可能なら SP 構築用の情報を返す。
export async function loadEnabledSsoContext(tenantId: string): Promise<SsoContextResult> {
  // テナントを取得する (存在しなければ not-found)
  const tenant = await repos.tenants.findById(tenantId);
  if (!tenant) return { ok: false, reason: 'not-found' };
  // Enterprise プランでなければ SSO は使えない (プラン降格後の無効化も含めサーバー側で強制)
  if (!isSsoAllowed(tenant.subscriptionPlan)) return { ok: false, reason: 'plan' };
  // テナントの SSO 設定を取得する (未設定なら config)
  const config = await repos.ssoConfigs.findByTenant(tenantId);
  if (!config) return { ok: false, reason: 'config' };
  // 設定はあるが無効化されている場合はログインさせない (fail-closed)
  if (!config.enabled) return { ok: false, reason: 'disabled' };
  // すべて満たしたので SP 構築に必要な情報を返す
  return { ok: true, tenant, config, baseUrl: resolveAppBaseUrl() };
}

// SSO 設定の作成/更新/削除 Server Action が共有する認可ゲートの結果。
// TenantAdminGate と全く同じ形状 (ok/tenantId/userId or ok:false/error) なので、
// 個別に再宣言せず型エイリアスにして将来のドリフト (片方だけ更新し忘れる) を防ぐ
export type SsoAdminGate = TenantAdminGate;

// SSO 設定変更の前提 (ログイン済み・admin・Enterprise プラン) をまとめて検証する。
// update/delete-sso-config の両 Server Action で重複していた認可チェックを 1 か所に集約し、
// セキュリティ上重要な「admin かつ Enterprise」ゲートの実装ドリフトを防ぐ。
export async function assertSsoConfigAdmin(): Promise<SsoAdminGate> {
  // 共通プリミティブで「ログイン済み・admin・自テナント」を検証する
  const gate = await assertTenantAdmin();
  // 不通過ならその理由をそのまま返す
  if (!gate.ok) return gate;
  // テナントを取得してプランが SSO を許可するか確認する (Enterprise のみ)
  const tenant = await repos.tenants.findById(gate.tenantId);
  if (!tenant) return { ok: false, error: 'テナント情報の取得に失敗しました' };
  if (!isSsoAllowed(tenant.subscriptionPlan)) {
    return { ok: false, error: 'SSO は Enterprise プランでのみ利用できます。' };
  }
  // すべて満たしたので共通プリミティブの結果 (tenantId/userId/email) をそのまま返す
  return gate;
}

// SSO 設定の削除専用ゲート: 「ログイン済み・admin・自テナント」のみを検証し、プランチェックは
// 行わない。プラン降格後に既存設定が削除できなくなる不具合を防ぐため (assertSsoConfigAdmin は
// 新規作成/更新など「これから SSO を使う」操作向けのゲートで、「もう使わない設定を消す」削除
// 操作には本来不要なプラン要件まで課してしまっていた)。loadEnabledSsoContext がログイン時に
// 独立してプランを検証しているため、削除ゲートを緩めても SSO ログインの fail-closed には影響しない。
export async function assertSsoConfigOwner(): Promise<SsoAdminGate> {
  // プランチェックが不要な分、共通プリミティブの結果をそのまま返す
  return assertTenantAdmin();
}
