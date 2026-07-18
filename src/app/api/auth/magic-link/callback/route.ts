/**
 * Magic-link callback route.
 *
 * Flow:
 *   1. User clicks the link in their email → GET /api/auth/magic-link/callback?token=<raw>
 *   2. GET handler returns an HTML confirmation page WITHOUT consuming the token.
 *      This prevents email security gateways (Microsoft Safe Links, Mimecast, etc.)
 *      from consuming the token during prefetch/crawl before the user clicks.
 *   3. User clicks "ログインする" → POST /api/auth/magic-link/callback (form submit)
 *   4. POST handler delegates to the `magic-link` Credentials Provider in auth.ts,
 *      which verifies the hash, checks expiry, marks the token consumed, and
 *      calls `signIn()` to attach the session cookie.
 *
 *  - On success, NextAuth attaches the session cookie to the redirect Response and
 *    forwards the browser to /login. The middleware then re-routes the now-authenticated
 *    request to /dashboard or /tickets depending on the user's role.
 *  - On failure (missing token, hash mismatch, expired, already consumed, user deleted),
 *    the user is redirected to /login?error=magic-link-invalid so the login page can
 *    surface a Japanese error message.
 *
 * Security properties of this design:
 *   - GET prefetch safety: email gateways that GET-prefetch links for malware scanning
 *     receive an HTML page but do NOT POST the form, so the token remains unconsumed.
 *   - Login CSRF / session swapping mitigation: the POST handler validates the request
 *     origin using Sec-Fetch-Site (Chrome/Firefox) or Origin header (Safari) to reject
 *     cross-origin form submissions. This prevents an attacker from tricking a victim's
 *     browser into consuming a magic link token via a cross-origin form.
 *     Note: Chromium sends Origin: "null" (literal string) for some localhost form
 *     submissions; Sec-Fetch-Site is used as the primary check to avoid this ambiguity.
 */

// next-auth の signIn ヘルパー (Credentials Provider にトークンを渡して認証 + リダイレクト)
import { signIn } from '@/lib/auth';
// authorize() が null を返した時の専用エラー (= 認証拒否)。
// AuthError は他にも CallbackRouteError / 設定不備系の運用エラーを含むため、
// 「ログインリンクが無効」と表示してよいのは CredentialsSignin に限定する
import { CredentialsSignin } from 'next-auth';
// Next.js の HTTP リダイレクト (NEXT_REDIRECT を throw する形で動作する)
import { redirect } from 'next/navigation';
// HTML に外部由来文字列を安全に差し込むためのエスケープ関数 (XSS 対策)
import { escapeHtml } from '@/lib/html-escape';
// トークン消費 (POST) 側の固定キーレート制限値 (監査で発見したギャップ対応)
import { MAGIC_LINK_CALLBACK_RATE_LIMIT } from '@/lib/magic-link';
// Route Handler 向け共通レート制限ラッパー (inbound-email/inbound-line/sso-acs と共有)
import { checkRouteRateLimit } from '@/lib/route-rate-limit';

// GET ハンドラ: トークンを消費せず HTML 確認ページを返す。
// メールゲートウェイのプリフェッチ対策として、実際の認証は POST でのみ行う。
export async function GET(request: Request) {
  // ?token=... を取り出す
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  // クエリにトークンが無ければそのままエラー画面へ
  if (!token) {
    // redirect() は NEXT_REDIRECT を throw する。catch せず上に流す
    redirect('/login?error=magic-link-invalid');
  }

  // base64url トークン ([A-Za-z0-9\-_] のみ) を HTML 属性値に差し込む前にエスケープする。
  // base64url 自体は危険な文字を含まないが、防御的に escapeHtml を通す
  const safeToken = escapeHtml(token);

  // ログイン確認ページの HTML を直接返す。
  // Next.js Page ではなく API Route で完結させることで、token を Query パラメータとして
  // 新たな URL に持ち込まず Referrer ヘッダに漏れるリスクを最小化する。
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ログイン確認 — HelpDesk Hub</title>
  <style>
    /* リセット兼ベーススタイル */
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      color: #1e293b;
    }
    /* カード: 白背景の中央寄せコンテナ */
    .card {
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
      padding: 2.5rem;
      max-width: 380px;
      width: 90%;
      text-align: center;
    }
    /* ロゴ的な見出し */
    .brand {
      font-size: 0.8rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #0f766e;
      margin: 0 0 1rem;
    }
    h1 { font-size: 1.25rem; font-weight: 700; margin: 0 0 0.5rem; color: #0f172a; }
    p  { margin: 0 0 1.5rem; font-size: 0.9rem; color: #64748b; line-height: 1.6; }
    /* ログインボタン: ブランドカラー (teal) */
    button {
      background: #0f766e;
      color: #ffffff;
      border: none;
      border-radius: 8px;
      padding: 0.75rem 2rem;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: background 0.15s;
    }
    button:hover  { background: #0d6660; }
    /* キーボードフォーカス時の可視リング (アクセシビリティ対応) */
    button:focus-visible { outline: 3px solid #14b8a6; outline-offset: 2px; }
  </style>
</head>
<body>
  <!-- <main> を使うことでスクリーンリーダーがランドマークとして認識できるようにする (CLAUDE.md §7) -->
  <main class="card">
    <p class="brand">HelpDesk Hub</p>
    <h1>ログイン確認</h1>
    <p>下のボタンをクリックするとログインが完了します。<br>心当たりがない場合はこのページを閉じてください。</p>
    <!-- action="" で現在の URL (このページ自身) へ POST する。絶対パスを避けることで
         Next.js の basePath 設定やリバースプロキシのプレフィックスに依存しない。
         トークンは POST ボディに含まれるため、GET プリフェッチではトークンが消費されない。 -->
    <form method="POST" action="">
      <input type="hidden" name="token" value="${safeToken}" />
      <button type="submit">ログインする</button>
    </form>
  </main>
</body>
</html>`;

  return new Response(html, {
    headers: {
      // HTML として解釈させる
      'Content-Type': 'text/html; charset=utf-8',
      // Referrer ヘッダにこのページの URL (≒ トークン) が後続リクエストに漏れないよう no-referrer に設定
      'Referrer-Policy': 'no-referrer',
      // 確認ページをキャッシュさせない (トークン再利用・古い確認ページの表示を防ぐ)
      'Cache-Control': 'no-store',
      // クリックジャッキング対策: このページを iframe に埋め込んで「ログインする」ボタンを
      // 踏ませる Login CSRF 攻撃を防ぐ (透明 iframe で別サイトボタンに重ね合わせる手法)
      'X-Frame-Options': 'DENY',
      // MIME スニッフィング防止: 返却する text/html を他の MIME タイプとして誤解釈させない
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// POST ハンドラ: フォーム送信でトークンを受け取り実際に認証を行う。
// ユーザーが明示的にボタンをクリックした場合のみ到達する。
export async function POST(request: Request) {
  // 固定キーの全体レート制限を最初に適用する (CSRF 検証やトークン消費 (DB 参照) より前に弾き、
  // 不正なトークンでの連打による DB 負荷増大を防ぐ。sso-acs と同じ「最初に置く」方針)
  const limitResponse = checkRouteRateLimit(
    'magic-link-callback',
    MAGIC_LINK_CALLBACK_RATE_LIMIT,
    'しばらく時間をおいて再度お試しください',
  );
  if (limitResponse) return limitResponse;

  // クロスオリジン CSRF 対策: 同一オリジンからのフォーム送信であることを検証する。
  // 検証戦略:
  //   1. Sec-Fetch-Site ヘッダ (Chrome 76+ / Firefox 90+): ブラウザが必ず付与し
  //      JavaScript から偽造できない Fetch Metadata ヘッダ。'same-origin' のみ許可する。
  //   2. Origin ヘッダ (Sec-Fetch-Site を送らない Safari 等): scheme+host+port を
  //      正規化して比較する。ブラウザが送信する 'null' 文字列 (file:// 等) は拒否する。
  //   3. どちらも存在しない場合: fail-closed で拒否する。

  // Sec-Fetch-Site ヘッダは Chrome/Firefox が自動付与する Fetch Metadata ヘッダ
  const secFetchSite = request.headers.get('sec-fetch-site');
  // サーバー側の正規オリジン (scheme + host + port) を取り出す
  const serverOrigin = new URL(request.url).origin;

  if (secFetchSite !== null) {
    // Sec-Fetch-Site が存在する場合 (Chrome/Firefox): 'same-origin' のみ許可する。
    // 'cross-site' は別ドメインからの送信 (CSRF 攻撃)、
    // 'same-site' は同一eTLD+1の別オリジン (許容しない)、
    // 'none' はダイレクトナビゲーション (form POST には通常現れない) なので拒否する。
    if (secFetchSite !== 'same-origin') {
      // クロスオリジン送信 = CSRF の疑い → fail-closed でエラー扱い
      redirect('/login?error=magic-link-invalid');
    }
  } else {
    // Sec-Fetch-Site がない場合 (Safari 等): Origin ヘッダで同一オリジンを確認する。
    const origin = request.headers.get('origin');
    // 'null' 文字列はブラウザが file:// や data: URL 等から送信する特殊な Origin 値。
    // 同一オリジンとは見なせないため除外する (null チェックとは別に文字列比較が必要)。
    let requestOrigin: string | null = null;
    if (origin && origin !== 'null') {
      try {
        // URL パースで scheme+host+port を正規化する (末尾スラッシュ等の揺れを吸収)
        requestOrigin = new URL(origin).origin;
      } catch {
        // 不正な URL 文字列の場合は null 扱い → 後段で拒否する (fail-closed)
        requestOrigin = null;
      }
    }
    if (!requestOrigin || requestOrigin !== serverOrigin) {
      // Origin 不一致または欠如は CSRF の疑いがあるためエラー扱い (fail-closed)
      redirect('/login?error=magic-link-invalid');
    }
  }

  // フォームの multipart/form-data または application/x-www-form-urlencoded からトークンを取り出す
  let token: string | undefined;
  try {
    // formData() は Content-Type が form 系でないとエラーになる可能性があるため try で包む
    const formData = await request.formData();
    token = formData.get('token')?.toString();
  } catch {
    // フォームとして解釈できない場合はトークン無しと同じ扱いにする
    redirect('/login?error=magic-link-invalid');
  }

  // トークンが無ければエラー画面へ
  if (!token) {
    redirect('/login?error=magic-link-invalid');
  }

  try {
    // signIn が成功した場合、内部で redirectTo へのリダイレクトを throw する。
    // middleware が tenantId 持ちセッションを見て /dashboard or /tickets へ再リダイレクトする
    await signIn('magic-link', {
      token,
      redirectTo: '/login',
    });
  } catch (error) {
    // authorize() が null を返したときの「認証拒否」だけを invalid 扱いにする。
    // AuthError 系の他のサブクラス (CallbackRouteError / 設定不備系) は運用障害なので
    // "magic-link-invalid" でユーザーに誤誘導せず、上位に投げて 500 にする
    if (error instanceof CredentialsSignin) {
      redirect('/login?error=magic-link-invalid');
    }
    // NEXT_REDIRECT や他の AuthError サブクラス、その他例外はそのまま上に伝播させる
    throw error;
  }
  // 通常はここに到達しない (signIn が redirect を throw するため)
  return new Response(null, { status: 204 });
}
