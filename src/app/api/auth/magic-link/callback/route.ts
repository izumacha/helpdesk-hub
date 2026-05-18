/**
 * Magic-link callback route.
 *
 * Browser hits `GET /api/auth/magic-link/callback?token=<raw>` when the user
 * clicks the link in their email. The handler delegates token verification
 * to the `magic-link` Credentials Provider (declared in `src/lib/auth.ts`)
 * via NextAuth's `signIn()` helper.
 *
 *  - On success, NextAuth attaches the session cookie to the redirect
 *    Response and forwards the browser to `/login`. The middleware then
 *    re-routes the now-authenticated request to `/dashboard` or `/tickets`
 *    depending on the user's role (single source of role-based routing).
 *  - On failure (missing token, hash mismatch, expired, already consumed,
 *    user deleted), the user is redirected to `/login?error=magic-link-invalid`
 *    so the login page can surface a Japanese error message.
 */
// next-auth の signIn ヘルパー (Credentials Provider にトークンを渡して認証 + リダイレクト)
import { signIn } from '@/lib/auth';
// authorize() が null を返した時の専用エラー (= 認証拒否)。
// AuthError は他にも CallbackRouteError / 設定不備系の運用エラーを含むため、
// 「ログインリンクが無効」と表示してよいのは CredentialsSignin に限定する
import { CredentialsSignin } from 'next-auth';
// Next.js の HTTP リダイレクト (NEXT_REDIRECT を throw する形で動作する)
import { redirect } from 'next/navigation';

// GET ハンドラ。Next.js App Router が自動でこの関数をルートに紐づけてくれる。
//
// TODO (フォローアップ / セキュリティ強化): 以下の 2 つの懸念を同一の対策で解決できる。
//   1) GET prefetch によるトークン消費 (Microsoft Safe Links / Mimecast 等): 受信者が
//      クリックする前にメールゲートウェイがリンクを GET prefetch してマルウェア検査し
//      トークンが消費されてしまい、本人が踏むと "magic-link-invalid" になる
//   2) Login CSRF / session swapping: URL トークン保有だけで認証が成立するため、攻撃者
//      が自分のアカウントでマジックリンクを発行し、被害者をその URL に誘導すると、被害者
//      のブラウザが攻撃者アカウントにログインしてしまう (Codex P2 指摘)
//
// 標準的な対策は GET を「ログインしますか？」確認ページ (state nonce + フォーム POST) に
// 変え、ユーザー操作した POST でのみトークン消費する方式。両懸念ともこれで防げる。
// 本 PR では UI 増分を抑えるため deferred (実装時は GET=HTML 確認ページ + POST=signIn)。
// 現状の SMB Lite ターゲット (Google Workspace / Office 365 中心、Safe Links 強制企業は
// 少数、login CSRF はマジックリンク開封導線という性質上 phishing 経路と区別しにくい) で
// 受け入れる判断。
export async function GET(request: Request) {
  // ?token=... を取り出す
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  // クエリにトークンが無ければそのままエラー画面へ
  if (!token) {
    // redirect() は NEXT_REDIRECT を throw する。catch せず上に流す
    redirect('/login?error=magic-link-invalid');
  }

  try {
    // signIn が成功した場合、内部で redirectTo へのリダイレクトを throw する。
    // この throw は NEXT_REDIRECT で、middleware が tenantId 持ちセッションを見て
    // /dashboard or /tickets へ再リダイレクトしてくれる (役割ベース)
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
  // 通常はここに到達しない。型を満たすためのフォールバック
  return new Response(null, { status: 204 });
}
