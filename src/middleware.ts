import { auth } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { isAgent } from '@/lib/role';

export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const isAuthPage = req.nextUrl.pathname.startsWith('/login');
  const isApiAuth = req.nextUrl.pathname.startsWith('/api/auth');

  if (isApiAuth) return NextResponse.next();

  if (!isLoggedIn && !isAuthPage) {
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
