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
// 信頼できるアプリケーションベース URL の解決 (NEXTAUTH_URL 優先・req.url の Host ヘッダに依存しない)
import { resolveAppBaseUrl } from '@/lib/app-url';
// SSO 有効性チェック
import { loadEnabledSsoContext } from '@/lib/sso-context';
// SAML SP 構築とアサーション検証
import { createSamlInstance, validateSamlResponse } from '@/lib/saml';
// マジックリンクのワンタイムトークン生成・ハッシュ (セッション発行に再利用)
import { generateMagicLinkToken, hashMagicLinkToken } from '@/lib/magic-link';
// HTML 属性への安全な埋め込み用エスケープ (確認ページのトークン埋め込みに使う)
import { escapeHtml } from '@/lib/html-escape';
// Route Handler 向け共通レート制限ラッパー (inbound-email/inbound-line と共有)
import { checkRouteRateLimit } from '@/lib/route-rate-limit';
// SSO エンドポイント群 (acs/login/metadata) が共有するレート制限の定数とメッセージ
// (/code-review ultra 指摘対応: 3 ファイルへの同一定数の複製を集約)
import {
  SSO_UNAUTHENTICATED_RATE_LIMIT,
  SSO_TENANT_RATE_LIMIT,
  SSO_RATE_LIMIT_MESSAGE,
} from '@/lib/sso-rate-limit';

// SSO ハンドオフトークンの有効期限 (2 分)。ACS → コールバックの即時引き渡し専用なので短くする
const SSO_HANDOFF_TTL_MS = 2 * 60 * 1000;

// 動的セグメント (tenantId) の型
type Params = { params: Promise<{ tenantId: string }> };

// POST ハンドラ: IdP からの SAMLResponse を受け取り検証してログインさせる
export async function POST(req: Request, { params }: Params) {
  // URL の tenantId を取り出す
  const { tenantId } = await params;
  // 失敗時のエラーリダイレクト (理由コードをログイン画面に渡す)。303 でブラウザを GET 遷移させる。
  // resolveAppBaseUrl() は NEXTAUTH_URL を優先し、未設定の本番では例外を投げる (fail-closed)。
  // req.url の Host ヘッダはユーザー制御可能なため、オープンリダイレクト防止のため使わない (§9)。
  const baseUrl = resolveAppBaseUrl();
  // code を union 型に制限して将来の呼び出し元が外部入力をそのまま渡す誤用を型レベルで防ぐ
  type SsoErrorCode = 'sso-unavailable' | 'sso-invalid' | 'sso-no-user';
  const errorRedirect = (code: SsoErrorCode) =>
    NextResponse.redirect(new URL(`/login?error=${code}`, baseUrl), 303);

  // 固定キーの全体レート制限を適用する (テナント解決より前に置き、URL の tenantId を
  // 変え続けることでのレート制限回避・DB 負荷増大を防ぐ。詳細は定数の定義コメント参照)
  const unauthLimitResponse = checkRouteRateLimit(
    'sso-acs:unauthenticated',
    SSO_UNAUTHENTICATED_RATE_LIMIT,
    SSO_RATE_LIMIT_MESSAGE,
  );
  // 制限超過なら 429 をそのまま返す (超過なしなら null が返り後続処理を続ける)
  if (unauthLimitResponse) return unauthLimitResponse;

  // SSO が利用可能か検証する (不可ならログイン画面へ)
  const ctx = await loadEnabledSsoContext(tenantId);
  // 無効な SSO 設定・テナント不在ならエラーリダイレクトで打ち切る
  if (!ctx.ok) return errorRedirect('sso-unavailable');

  // テナントが実在し SSO が有効だと確認できたので、ここからは信頼できる tenantId を
  // キーにしたテナント単位のレート制限を適用する (この後の XML パース・署名検証は
  // CPU コストが高いため、その前に弾く)
  const tenantLimitResponse = checkRouteRateLimit(
    `sso-acs:${tenantId}`,
    SSO_TENANT_RATE_LIMIT,
    SSO_RATE_LIMIT_MESSAGE,
  );
  // テナント単位の制限超過なら 429 をそのまま返す
  if (tenantLimitResponse) return tenantLimitResponse;

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
  let assertionId: string;
  try {
    // テナントの SSO 設定から SP を構築する
    const saml = createSamlInstance(ctx.config, ctx.baseUrl, tenantId);
    // アサーションを検証する (署名不正・Issuer/Audience 不一致・期限切れは例外)。
    // expectedIssuer に設定の IdP EntityID を渡し、Issuer 一致も多層防御として検証する
    const identity = await validateSamlResponse(saml, samlResponse, ctx.config.idpEntityId);
    // 取り出したメール (検証済み)
    email = identity.email;
    // リプレイ防止の一意キーとして使うアサーション ID (検証済み)
    assertionId = identity.assertionId;
  } catch (err) {
    // 検証失敗は内部詳細を返さずログイン画面へ戻す (なりすまし/設定ミスを区別せず拒否)
    console.error('[sso-acs] アサーション検証に失敗しました:', err);
    return errorRedirect('sso-invalid');
  }

  // リプレイ対策: 同一アサーション (tenantId + assertionId) の 2 回目以降の利用を拒否する。
  // 署名検証は「正当な IdP が発行した」ことしか保証せず、有効期限内の同じ SAMLResponse を
  // 攻撃者が繰り返し POST しても検証は毎回成功してしまうため、消費済みかどうかを別途記録する
  // (一意制約によるアトミックな判定。同時に同じアサーションで 2 リクエストが来ても片方だけ通る)。
  const isFirstUse = await repos.samlAssertions.recordIfNew({ tenantId, assertionId });
  if (!isFirstUse) {
    // メールアドレスはログに残さず、リプレイ検知の事実だけを残す
    console.warn(
      '[sso-acs] 同一 SAML アサーションの再利用を検知しました (リプレイ防止により拒否)。',
    );
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

  // ── ログイン CSRF / セッション固定対策 (ユーザー操作を必須化する確認ページ) ──
  // ACS は未認証で到達でき、IdP-initiated SSO では未承諾の署名付きアサーションも受理する
  // (InResponseTo は IdP-initiated を壊し共有キャッシュも要るため使わない)。
  // ここで自動ログインせず「明示クリックの確認ページ」を挟むことで、攻撃者が被害者ブラウザから
  // ACS へ自前アサーションを自動 POST させて「攻撃者アカウントでサイレントログイン」させる攻撃を防ぐ。
  // (マジックリンクのコールバックコメントが示す標準対策と同方針。SP/IdP どちらの起点でも有効。)
  return new NextResponse(renderSsoContinuePage(rawToken), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // 確認ページ自体はキャッシュ・参照させない (トークンを含むため)
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      // クリックジャッキング防止 (必須): この確認ページの安全性は「ユーザーの明示クリック」に
      // 依存するため、iframe 埋め込み + UI 偽装でクリックを誘導されると CSRF 対策が無力化する。
      // フレーム化を全面禁止して埋め込みを防ぐ (frame-ancestors=現代ブラウザ / XFO=レガシー)。
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
    },
  });
}

// SSO 認証後に表示する「ログイン続行の確認」ページを描画する。
// 自動送信せず、ユーザーが明示的にボタンを押したときだけマジックリンクのコールバック (GET) へ
// 遷移してセッションを発行する。token は HTML 属性として安全にエスケープして埋め込む。
function renderSsoContinuePage(rawToken: string): string {
  // トークンを HTML 属性値に安全に埋め込めるようエスケープする (base64url だが防御的に処理)
  const safeToken = escapeHtml(rawToken);
  // 確認ページの HTML を返す。lang="ja"・セマンティックなボタン・自動送信なしを満たす。
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>SSO ログインの確認</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f0fdfa; color: #0f172a; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 1rem; }
  main { background: #fff; border: 1px solid #ccfbf1; border-radius: 1rem; padding: 2rem; max-width: 28rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  p { font-size: .9rem; color: #475569; line-height: 1.6; }
  button { margin-top: 1.25rem; width: 100%; background: #0f766e; color: #fff; border: 0; border-radius: .5rem; padding: .75rem 1rem; font-size: .95rem; font-weight: 600; cursor: pointer; }
  button:hover { background: #115e59; }
  button:focus-visible { outline: 3px solid #5eead4; outline-offset: 2px; }
</style>
</head>
<body>
<main>
<h1>SSO ログインの確認</h1>
<p>シングルサインオン (SSO) の認証が完了しました。下のボタンを押すと、このアプリへのログインが完了します。心当たりがない場合はこのページを閉じてください。</p>
<form method="get" action="/api/auth/magic-link/callback">
<input type="hidden" name="token" value="${safeToken}">
<button type="submit">ログインを続ける</button>
</form>
</main>
</body>
</html>`;
}
