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
// Route Handler 向け共通レート制限ラッパー (login/acs の各 route.ts と共有)
import { checkRouteRateLimit } from '@/lib/route-rate-limit';

// 監査で発見したギャップ: 同じ SSO エンドポイント群のうち login/acs はレート制限済みで、
// このエンドポイントには無かった。未認証で到達でき、リクエストごとに DB 参照
// (tenants.findById) が発生するため、URL の tenantId を変え続けて連打されると DB 負荷に
// つながる。tenantId は DB 検証前の値で攻撃者が自由に変更できるため、login/acs と同じ
// 理由で固定キーの全体制限にする (テナント単位のキーだけでは変更するだけで回避できる)。
const SSO_METADATA_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

// 動的セグメント (tenantId) の型
type Params = { params: Promise<{ tenantId: string }> };

// GET ハンドラ: SP メタデータ XML を返す
export async function GET(_req: Request, { params }: Params) {
  // 固定キーの全体レート制限を適用する (DB 参照より前に置き、URL の tenantId を
  // 変え続けることでのレート制限回避・DB 負荷増大を防ぐ)
  const limitResponse = checkRouteRateLimit(
    'sso-metadata:unauthenticated',
    SSO_METADATA_RATE_LIMIT,
    'しばらく時間をおいて再度お試しください',
  );
  if (limitResponse) return limitResponse;

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
