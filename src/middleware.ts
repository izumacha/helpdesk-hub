import { auth } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { isAgent } from '@/lib/role';

// 認証ミドルウェア
// - ログイン状態のチェック (未ログインは /login に飛ばす or API は 401 を返す)
// - tenantId 不在セッションを強制的にリログインさせる (Phase 0 マルチテナント化の前提)
export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const isAuthPage = req.nextUrl.pathname.startsWith('/login');
  const isApiAuth = req.nextUrl.pathname.startsWith('/api/auth');
  const isApiRoute = req.nextUrl.pathname.startsWith('/api/');

  if (isApiAuth) return NextResponse.next();

  if (isApiRoute) {
    if (!isLoggedIn) {
      return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
    }
    // ログイン済みでも tenantId が無いセッションは Phase 0 移行以前のもの。
    // Server Action / Page では tenantId を where に注入するので、ここで弾いてリログインを促す。
    if (!req.auth?.user?.tenantId) {
      return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (!isLoggedIn && !isAuthPage) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  // 認証済み HTML 遷移でも tenantId 不在なら /login に戻す (旧 JWT 互換性のセーフティネット)
  // 通常は auth.ts の jwt callback が補完するが、補完失敗時の最後の砦としてここでも判定する
  if (isLoggedIn && !isAuthPage && !req.auth?.user?.tenantId) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  if (isLoggedIn && isAuthPage) {
    const role = req.auth?.user?.role;
    return NextResponse.redirect(new URL(isAgent(role) ? '/dashboard' : '/tickets', req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
