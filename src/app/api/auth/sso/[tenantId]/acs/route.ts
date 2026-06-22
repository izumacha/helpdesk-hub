// Phase 4 Enterprise: SAML SSO の Assertion Consumer Service (ACS)。
// docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」。
//
// POST /api/auth/sso/<tenantId>/acs
//   IdP がユーザー認証後に署名付き SAMLResponse をこの URL へ POST する。
//   署名・Issuer・Audience・期限を検証し、本人のメールでテナント内のユーザーを特定して
//   セッションを発行する。セッション発行は実績あるマジックリンク経路を再利用する
//   (ワンタイムトークンを 1 件発行 → マジックリンクのコールバックに 303 リダイレクト)。
//
// セキュリティ:
//   - 署名検証は node-saml に委譲し fail-closed (検証失敗は即ログイン拒否)。
//   - IdP が主張したメールのユーザーが「この tenantId に属する」ことを必須化し、
//     別 IdP/別テナントのなりすましでクロステナントログインさせない。
//   - 自動ユーザー作成 (JIT) は行わない。既存ユーザーのみ SSO ログインを許可する。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// HTTP レスポンス生成
import { NextResponse } from 'next/server';
// データ層 (ユーザー検索・トークン発行)
import { repos } from '@/data';
// SSO 有効性チェック
import { loadEnabledSsoContext } from '@/lib/sso-context';
// SAML SP 構築とアサーション検証
import { createSamlInstance, validateSamlResponse } from '@/lib/saml';
// マジックリンクのワンタイムトークン生成・ハッシュ・コールバック URL 構築 (セッション発行に再利用)
import {
  buildMagicLinkUrl,
  generateMagicLinkToken,
  hashMagicLinkToken,
} from '@/lib/magic-link';

// SSO ハンドオフトークンの有効期限 (2 分)。ACS → コールバックの即時引き渡し専用なので短くする
const SSO_HANDOFF_TTL_MS = 2 * 60 * 1000;

// 動的セグメント (tenantId) の型
type Params = { params: Promise<{ tenantId: string }> };

// POST ハンドラ: IdP からの SAMLResponse を受け取り検証してログインさせる
export async function POST(req: Request, { params }: Params) {
  // URL の tenantId を取り出す
  const { tenantId } = await params;
  // 失敗時のエラーリダイレクト (理由コードをログイン画面に渡す)。303 でブラウザを GET 遷移させる
  const errorRedirect = (code: string) =>
    NextResponse.redirect(new URL(`/login?error=${code}`, req.url), 303);

  // SSO が利用可能か検証する (不可ならログイン画面へ)
  const ctx = await loadEnabledSsoContext(tenantId);
  if (!ctx.ok) return errorRedirect('sso-unavailable');

  // POST ボディ (application/x-www-form-urlencoded) から SAMLResponse を取り出す
  let samlResponse: string;
  try {
    // フォームデータをパースする
    const form = await req.formData();
    // SAMLResponse フィールドを取得する
    const value = form.get('SAMLResponse');
    // 文字列でなければ不正な応答として扱う
    if (typeof value !== 'string' || value.length === 0) return errorRedirect('sso-invalid');
    samlResponse = value;
  } catch {
    // ボディが壊れている場合は不正扱い
    return errorRedirect('sso-invalid');
  }

  // 署名・条件を検証して本人のメールを取り出す
  let email: string;
  try {
    // テナントの SSO 設定から SP を構築する
    const saml = createSamlInstance(ctx.config, ctx.baseUrl, tenantId);
    // アサーションを検証する (署名不正・Issuer/Audience 不一致・期限切れは例外)。
    // expectedIssuer に設定の IdP EntityID を渡し、Issuer 一致も多層防御として検証する
    const identity = await validateSamlResponse(saml, samlResponse, ctx.config.idpEntityId);
    // 取り出したメール (検証済み)
    email = identity.email;
  } catch (err) {
    // 検証失敗は内部詳細を返さずログイン画面へ戻す (なりすまし/設定ミスを区別せず拒否)
    console.error('[sso-acs] アサーション検証に失敗しました:', err);
    return errorRedirect('sso-invalid');
  }

  // メールに対応する既存ユーザーを引く
  const user = await repos.users.findByEmail(email);
  // ユーザーが存在しない、または別テナントのユーザーなら拒否する (クロステナント防止 + JIT 無効)
  if (!user || user.tenantId !== tenantId) {
    // 監査用に警告ログを残す (メールアドレスはログに残さず件数のみ気付ける程度に留める)
    console.warn('[sso-acs] SSO 本人に対応するテナント内ユーザーが見つかりません。');
    return errorRedirect('sso-no-user');
  }

  // セッション発行: ワンタイムトークンを 1 件発行してマジックリンクのコールバックへ渡す
  // 生トークンは URL でのみ運び、DB には SHA-256 ハッシュを保存する (マジックリンクと同方式)
  const rawToken = generateMagicLinkToken();
  // 生トークンを SHA-256 ハッシュ化して DB 検索キーにする
  const tokenHash = await hashMagicLinkToken(rawToken);
  // ハンドオフ用の短い失効時刻を設定する
  const expiresAt = new Date(Date.now() + SSO_HANDOFF_TTL_MS);
  // 発行元 IP を監査用に取得する (プロキシ経由の x-forwarded-for を優先)
  const requestedIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  // ワンタイムトークンを保存する (consume はマジックリンクのコールバックが原子的に行う)
  await repos.magicLinks.create({ email: user.email, tokenHash, expiresAt, requestedIp });

  // マジックリンクのコールバック URL を組み立て、そこへ 303 リダイレクトしてセッションを発行させる
  const callbackUrl = buildMagicLinkUrl(ctx.baseUrl, rawToken);
  return NextResponse.redirect(callbackUrl, 303);
}
