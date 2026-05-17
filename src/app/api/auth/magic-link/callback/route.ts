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
// next-auth が認証失敗時に投げる基底エラー (CredentialsSignin もこれを継承)
import { AuthError } from 'next-auth';
// Next.js の HTTP リダイレクト (NEXT_REDIRECT を throw する形で動作する)
import { redirect } from 'next/navigation';

// GET ハンドラ。Next.js App Router が自動でこの関数をルートに紐づけてくれる
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
    // 認証エラー (トークン不一致 / 期限切れ / 消費済み 等) は AuthError 系で来る
    if (error instanceof AuthError) {
      // 日本語メッセージ表示用のクエリ付きで /login に戻す
      redirect('/login?error=magic-link-invalid');
    }
    // NEXT_REDIRECT などはそのまま上に伝播させる (Next.js が処理する)
    throw error;
  }
  // 通常はここに到達しない。型を満たすためのフォールバック
  return new Response(null, { status: 204 });
}
