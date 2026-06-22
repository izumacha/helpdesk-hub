// Phase 4 Enterprise: SAML SP メタデータエンドポイント。
// docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」。
//
// GET /api/auth/sso/<tenantId>/metadata
//   IdP 側に登録するための SP メタデータ (EntityDescriptor) XML を返す。
//   IdP 証明書が未設定の段階でも参照できる必要があるため、SSO 設定の有無は問わず
//   テナントの存在と Enterprise プランだけを条件にする (中身は秘密情報を含まない)。
export const runtime = 'nodejs';

// HTTP レスポンス生成
import { NextResponse } from 'next/server';
// データ層 (テナント取得)
import { repos } from '@/data';
// プラン別の SSO 可否ゲート (Enterprise のみ)
import { isSsoAllowed } from '@/lib/plan-guard';
// アプリの公開ベース URL 解決
import { resolveAppBaseUrl } from '@/lib/app-url';
// SP メタデータ XML 生成 (純粋関数)
import { buildSpMetadataXml } from '@/lib/saml';

// 動的セグメント (tenantId) の型
type Params = { params: Promise<{ tenantId: string }> };

// GET ハンドラ: SP メタデータ XML を返す
export async function GET(_req: Request, { params }: Params) {
  // URL の tenantId を取り出す
  const { tenantId } = await params;
  // テナントを取得する
  const tenant = await repos.tenants.findById(tenantId);
  // テナントが存在しない、または Enterprise プランでなければ 404 (機能非提供)
  if (!tenant || !isSsoAllowed(tenant.subscriptionPlan)) {
    return new NextResponse('SSO はこのテナントでは利用できません。', { status: 404 });
  }
  // SP メタデータ XML を組み立てる (秘密情報を含まない SP の URL のみ)
  const xml = buildSpMetadataXml(resolveAppBaseUrl(), tenantId);
  // XML として返す
  return new NextResponse(xml, {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}
