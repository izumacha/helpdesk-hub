import { auth } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { isAgent } from '@/lib/role';

// 認証ミドルウェア
// - ログイン状態のチェック (未ログインは /login に飛ばす or API は 401 を返す)
// - tenantId 不在セッションを強制的にリログインさせる (Phase 0 マルチテナント化の前提)
export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const isAuthPage = req.nextUrl.pathname.startsWith('/login');
  // 招待受諾ページは未認証で開ける公開ページ (トークン自体が認可の根拠)。
  // /login と同様にログインガードの対象外にする。
  const isInvitePage = req.nextUrl.pathname.startsWith('/invite');
  // ヘルプセンター (Phase 3) は未認証でも閲覧できる公開ページ。
  // 「30 分で導入開始」シナリオで、ログイン前にヘルプを参照できることが重要。
  const isHelpPage = req.nextUrl.pathname.startsWith('/help');
  const isApiAuth = req.nextUrl.pathname.startsWith('/api/auth');
  // メール取り込み等の受信 Webhook はセッションを持たず、ルート側で共有シークレットを
  // 検証して自前で認可する (Phase 2)。セッション認証ガードの対象外にする。
  // 末尾スラッシュ込みで前方一致させ、/api/inboundx のような別名ルートまで誤って開けない。
  const isApiInbound = req.nextUrl.pathname.startsWith('/api/inbound/');
  const isApiRoute = req.nextUrl.pathname.startsWith('/api/');

  if (isApiAuth || isApiInbound) return NextResponse.next();

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

  if (!isLoggedIn && !isAuthPage && !isInvitePage && !isHelpPage) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  // 認証済み HTML 遷移でも tenantId 不在なら /login に戻す (旧 JWT 互換性のセーフティネット)
  // 通常は auth.ts の jwt callback が補完するが、補完失敗時の最後の砦としてここでも判定する。
  // 招待受諾ページ・ヘルプページは公開のため対象外 (ログイン済みでも閲覧を許す)
  if (isLoggedIn && !isAuthPage && !isInvitePage && !isHelpPage && !req.auth?.user?.tenantId) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  if (isLoggedIn && isAuthPage) {
    // tenantId 不在の旧 JWT 補完失敗セッションが /login に到達した場合は
    // dashboard/tickets に戻さない (アプリ画面側で再度 /login に弾かれてループするため)。
    // ログイン画面をそのまま表示してパスワード再入力 → 新 JWT 発行を促す
    if (!req.auth?.user?.tenantId) {
      return NextResponse.next();
    }
    const role = req.auth?.user?.role;
    return NextResponse.redirect(new URL(isAgent(role) ? '/dashboard' : '/tickets', req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
