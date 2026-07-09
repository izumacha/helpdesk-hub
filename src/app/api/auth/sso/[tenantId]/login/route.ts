// Phase 4 Enterprise: SAML SSO ログイン開始エンドポイント。
// docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」。
//
// GET /api/auth/sso/<tenantId>/login
//   テナントの SSO が有効なら AuthnRequest を生成し IdP のログイン画面へリダイレクトする。
//   未認証で到達する想定 (middleware は /api/auth/* を認証ガード対象外にしている)。
//
// node-saml は Node 専用ライブラリのため Node ランタイムで動かす。
export const runtime = 'nodejs';
// SSO 開始はキャッシュせず毎回動的に処理する
export const dynamic = 'force-dynamic';

// HTTP レスポンス生成
import { NextResponse } from 'next/server';
// SSO 有効性チェック (テナント存在・プラン・設定・有効フラグ)
import { loadEnabledSsoContext } from '@/lib/sso-context';
// SAML SP インスタンス生成とログイン URL 生成
import { createSamlInstance, getSsoLoginUrl } from '@/lib/saml';
// 信頼できるアプリケーションベース URL の解決 (NEXTAUTH_URL 優先・req.url の Host ヘッダに依存しない)
import { resolveAppBaseUrl } from '@/lib/app-url';
// Route Handler 向け共通レート制限ラッパー (acs/route.ts と共有)
import { checkRouteRateLimit } from '@/lib/route-rate-limit';
// SSO エンドポイント群 (acs/login/metadata) が共有するレート制限の定数とメッセージ
import {
  SSO_UNAUTHENTICATED_RATE_LIMIT,
  SSO_TENANT_RATE_LIMIT,
  SSO_RATE_LIMIT_MESSAGE,
} from '@/lib/sso-rate-limit';

// 監査で発見したギャップ: 同じ SSO エンドポイント群のうち acs/route.ts だけがレート制限済みで、
// この /login エンドポイントには無かった。未認証で到達でき、有効な SSO であれば
// AuthnRequest 生成 (createSamlInstance + getSsoLoginUrl) という相応のコストがかかる処理を
// 都度行うため、acs/route.ts と同じ二段構えの制限を適用する (制限値・理由は
// src/lib/sso-rate-limit.ts のコメント参照)。

// 動的セグメント (tenantId) の型 (Next.js 15 では params は Promise)
type Params = { params: Promise<{ tenantId: string }> };

// GET ハンドラ: SSO ログインを開始する
export async function GET(_req: Request, { params }: Params) {
  // URL の tenantId を取り出す
  const { tenantId } = await params;
  // NEXTAUTH_URL を優先してベース URL を取得する。req.url の Host ヘッダはユーザー制御可能なため
  // オープンリダイレクト防止のため使わない (§9 / acs/route.ts と同方針)。
  const baseUrl = resolveAppBaseUrl();
  // 失敗時に共通で使うエラーリダイレクト (ログイン画面へ理由付きで戻す)
  const errorRedirect = () =>
    NextResponse.redirect(new URL('/login?error=sso-unavailable', baseUrl), 303);

  // 固定キーの全体レート制限を適用する (テナント解決より前に置き、URL の tenantId を
  // 変え続けることでのレート制限回避・DB 負荷増大を防ぐ)
  const unauthLimitResponse = checkRouteRateLimit(
    'sso-login:unauthenticated',
    SSO_UNAUTHENTICATED_RATE_LIMIT,
    SSO_RATE_LIMIT_MESSAGE,
  );
  // 制限超過なら 429 をそのまま返す (超過なしなら null が返り後続処理を続ける)
  if (unauthLimitResponse) return unauthLimitResponse;

  // SSO が利用可能か検証する (不可ならログイン画面へ)
  const ctx = await loadEnabledSsoContext(tenantId);
  // 無効な SSO 設定・テナント不在ならエラーリダイレクトで打ち切る
  if (!ctx.ok) return errorRedirect();

  // テナントが実在し SSO が有効だと確認できたので、信頼できる tenantId をキーにした
  // テナント単位のレート制限を、この後の AuthnRequest 生成の前に適用する
  const tenantLimitResponse = checkRouteRateLimit(
    `sso-login:${tenantId}`,
    SSO_TENANT_RATE_LIMIT,
    SSO_RATE_LIMIT_MESSAGE,
  );
  // テナント単位の制限超過なら 429 をそのまま返す
  if (tenantLimitResponse) return tenantLimitResponse;

  try {
    // テナントの SSO 設定から SAML SP インスタンスを構築する
    const saml = createSamlInstance(ctx.config, ctx.baseUrl, tenantId);
    // AuthnRequest を生成し IdP のログイン URL を得る
    const redirectUrl = await getSsoLoginUrl(saml);
    // IdP のログイン画面へリダイレクトする (外部 URL)
    return NextResponse.redirect(redirectUrl, 303);
  } catch (err) {
    // 設定不備や AuthnRequest 生成失敗は内部詳細を返さずログイン画面へ戻す (§9)
    console.error('[sso-login] AuthnRequest の生成に失敗しました:', err);
    return errorRedirect();
  }
}
