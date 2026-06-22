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
