/**
 * リクエスト入口の認証ガード (Next.js 16 `proxy` file convention / issue #298)。
 *
 * **ランタイムが Edge から Node.js に変わっている。** 15 までの `middleware` 規約は既定で
 * Edge ランタイムだったが、proxy 規約は常に Node.js ランタイムで動く (Next.js 側の仕様で、
 * `export const runtime = ...` を書くとビルドエラーになる)。この移行は規約に従っただけだが、
 * 結果として**実在のバグが直っている**ので、再発防止のため経緯を残す:
 *
 *   `auth` (`@/lib/auth`) の `jwt` コールバックは、tenantId 欠落の旧 JWT 補完とロールの定期
 *   リフレッシュ (30 分間隔) のために `repos.users.findById()` で DB を引く。この Prisma
 *   クライアントは `prisma-client-js` (ネイティブの library engine) で生成されており、Edge
 *   ランタイムでは動かない。そのため Edge 時代は、セッションが 30 分を超えて初めてリフレッシュ
 *   経路に入った瞬間に `PrismaClient is not configured to run in Edge Runtime` が送出され、
 *   next-auth がそれを `JWTSessionError` として扱い、**有効なセッションを持つログイン中の
 *   ユーザーが /login に弾き返されていた** (旧 JWT の tenantId 補完経路も同様)。
 *   ログイン直後の 30 分間は DB を引かないため、E2E も含めて表面化しにくい種類の不具合だった。
 *
 *   検証方法 (再現させたいとき): `ROLE_REFRESH_INTERVAL_MS` を一時的に 0 にして毎リクエストで
 *   DB 経路を通し、ログイン後に保護ページを開く。Edge (旧 `middleware.ts`) では 307 → /login、
 *   Node.js (本ファイル) では 200 になる。
 *
 * ガードの中身自体はこの移行で変更していない (未認証 API は 401 / 未認証 HTML は /login /
 * tenantId 不在は再ログイン誘導 / ログイン済みの /login はロール別に退避)。
 */

import { auth } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { isAgent } from '@/lib/role';

// セッション認証ガードの対象外にする、共有シークレット認証の内部 cron エンドポイントの一覧。
// /code-review ultra 指摘対応: 「/api/internal/」配下丸ごとをプレフィックスで除外すると、
// 「内部向け = 安全」という誤解を招きやすい名前のため、将来ここに認証を自前実装し忘れた
// 別ルートが追加されてもセッション認証ガードの対象から外れないよう、個別ルートを明示列挙する
const INTERNAL_CRON_ROUTES = [
  '/api/internal/trial-reminders',
  // issue-backlog #20 フォローアップ: SLA 期限接近リマインダー (POST /api/internal/sla-reminders)。
  // trial-reminders と同じく共有シークレットで自前認可するため、明示的にここへ追加する
  '/api/internal/sla-reminders',
];

// 認証プロキシ (Next.js 16 の `proxy` file convention。15 までの `middleware` の後継 / issue #298)
// - ログイン状態のチェック (未ログインは /login に飛ばす or API は 401 を返す)
// - tenantId 不在セッションを強制的にリログインさせる (Phase 0 マルチテナント化の前提)
//
// **エクスポート名は `proxy` 固定。** Next.js の proxy 用エントリテンプレートは
// `mod.proxy || mod.default` の順に解決するため default export でも動くが、規約どおりの
// 名前付きエクスポートにしておくと「この関数がリクエスト入口である」ことがファイル内で自明になる。
export const proxy = auth((req) => {
  const isLoggedIn = !!req.auth;
  const isAuthPage = req.nextUrl.pathname.startsWith('/login');
  // 招待受諾ページは未認証で開ける公開ページ (トークン自体が認可の根拠)。
  // /login と同様にログインガードの対象外にする。
  const isInvitePage = req.nextUrl.pathname.startsWith('/invite');
  // セルフサーブサインアップ (§7.1) も未認証で開ける公開ページ。まだテナント/アカウントが
  // 存在しない見込み客が最初に訪れる入口のため、/login・/invite と同様に対象外にする。
  const isSignupPage = req.nextUrl.pathname.startsWith('/signup');
  // ヘルプセンター (Phase 3) は未認証でも閲覧できる公開ページ。
  // 「30 分で導入開始」シナリオで、ログイン前にヘルプを参照できることが重要。
  const isHelpPage = req.nextUrl.pathname.startsWith('/help');
  const isApiAuth = req.nextUrl.pathname.startsWith('/api/auth');
  // メール取り込み等の受信 Webhook はセッションを持たず、ルート側で共有シークレットを
  // 検証して自前で認可する (Phase 2)。セッション認証ガードの対象外にする。
  // 末尾スラッシュ込みで前方一致させ、/api/inboundx のような別名ルートまで誤って開けない。
  const isApiInbound = req.nextUrl.pathname.startsWith('/api/inbound/');
  // Stripe Webhook はサーバー間通信のためセッションを持たない。
  // ルート側で HMAC 署名検証 (stripe.webhooks.constructEvent) を行うため、
  // セッション認証ガードの対象外にする (Phase 4 課金)。
  const isApiWebhook = req.nextUrl.pathname.startsWith('/api/webhooks/');
  // 内部 cron 専用エンドポイント (trial-reminders / sla-reminders) はブラウザセッションを持たず、
  // GitHub Actions 等の定期実行ジョブから共有シークレット (Authorization: Bearer) で
  // 叩かれる。ルート側で constantTimeStringEqual による検証を行うため、ここでは
  // isApiInbound / isApiWebhook と同じ理由でセッション認証ガードの対象外にする
  // (§7.2.1 Free trial 終了リマインダー・issue-backlog #20。対象ルートは INTERNAL_CRON_ROUTES で明示列挙)。
  const isApiInternal = INTERNAL_CRON_ROUTES.includes(req.nextUrl.pathname);
  const isApiRoute = req.nextUrl.pathname.startsWith('/api/');

  if (isApiAuth || isApiInbound || isApiWebhook || isApiInternal) return NextResponse.next();

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

  if (!isLoggedIn && !isAuthPage && !isInvitePage && !isSignupPage && !isHelpPage) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  // 認証済み HTML 遷移でも tenantId 不在なら /login に戻す (旧 JWT 互換性のセーフティネット)
  // 通常は auth.ts の jwt callback が補完するが、補完失敗時の最後の砦としてここでも判定する。
  // 招待受諾ページ・サインアップページ・ヘルプページは公開のため対象外 (ログイン済みでも閲覧を許す)
  if (
    isLoggedIn &&
    !isAuthPage &&
    !isInvitePage &&
    !isSignupPage &&
    !isHelpPage &&
    !req.auth?.user?.tenantId
  ) {
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

// 適用範囲: 静的アセット (_next/static / _next/image / favicon.ico) 以外の全リクエスト。
// **除外を増やすときは慎重に** — ここから外れたパスは認証ガードを一切通らない。
// なお proxy 規約では `runtime` などの route segment config を書くとビルドエラーになる
// (proxy は常に Node.js ランタイムで動くため、指定する余地がない)。matcher の指定は従来どおり。
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
