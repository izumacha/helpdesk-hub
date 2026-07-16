// 現在のセッション (ログイン情報) 取得
import { auth } from '@/lib/auth';
// 上部ヘッダー
import { Header } from '@/components/layout/Header';
// 左サイドバー
import { Sidebar } from '@/components/layout/Sidebar';
// モバイル時のサイドバードロワー開閉状態を Header / Sidebar 間で共有する Provider
import { MobileNavProvider } from '@/components/layout/MobileNavProvider';
// 本文へ飛ぶスキップリンク (§7 a11y)
import { SkipLink } from '@/components/layout/SkipLink';
// クライアントサイド遷移のたびに本文へフォーカスを移す (§7 a11y)
import { RouteFocusManager } from '@/components/layout/RouteFocusManager';
// <main> に振る id の単一の参照元 (§6 マジック文字列を避ける)
import { MAIN_CONTENT_ID } from '@/components/layout/main-content-id';
// 現在テナントの動作モード(lite | pro)を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';
// §6.1 料金プラン「Free: ロゴ表示」の判定用。トライアル中の実効プランを返す
// (Free trial 中は Standard 相当のためロゴを表示しない)
import { resolveTenantPlan } from '@/lib/tenant-plan';

// (app) Route Group の共通レイアウト (認証後の画面骨格)
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // セッション取得 (middleware で未ログインは弾かれている前提)
  const session = await auth();
  // ロール (権限) を取得。万一未取得なら最弱権限の requester にフォールバック
  const role = session?.user?.role ?? ('requester' as const);
  // テナントの動作モード (lite | pro) を取得し、メニュー出し分けに使う
  // (tenantId を渡して二重 session 読み込みを回避。未ログイン時は既定 lite)
  const mode = await getCurrentTenantMode(session?.user?.tenantId);
  // §6.1 料金プラン表「Free: ロゴ表示」。実効プラン (トライアル昇格を含む) が free の
  // テナントにだけ「Powered by」表記を出す (Standard 以上・トライアル中は非表示)
  const plan = session?.user?.tenantId ? await resolveTenantPlan(session.user.tenantId) : 'free';

  return (
    // モバイルでのサイドバー開閉状態を Header (トグルボタン) と Sidebar (ドロワー本体) で共有する
    // Provider は client コンポーネントだが、async な Header/Sidebar の親に置けるため
    // children のレンダリング順序や Server Action 利用を妨げない
    <MobileNavProvider>
      {/* 本文へ飛ぶスキップリンク (§7 a11y)。通常は視覚的に隠れており、Tab で最初にフォーカスされたときのみ表示 */}
      <SkipLink />
      {/* クライアントサイド遷移のたびに #main-content へフォーカスを移す (画面には何も描画しない) */}
      <RouteFocusManager />
      {/* 画面全体: 左右レイアウト + 縦スクロール抑止 (背景は新トークン surface) */}
      <div className="bg-surface flex h-screen overflow-hidden">
        {/* サイドバー (権限とモードに応じてメニューを出し分け。md 未満は Provider 状態でドロワー化) */}
        <Sidebar role={role} mode={mode} />
        {/* 右側: ヘッダー + メインコンテンツ */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <Header />
          {/* 各ページの内容 (縦スクロール可) ─ モバイルは余白を控えめにする。
              id=MAIN_CONTENT_ID/tabIndex={-1} はスキップリンクの遷移先 + ページ遷移後の
              フォーカス移動先 (RouteFocusManager) として使う。tabIndex={-1} なので
              通常の Tab 移動では選択されず、programmatic focus() でのみフォーカス可能。
              フォローアップ (2026-07-16 #2 レビュー対応): 当初 focus:outline-none のみで
              代替の見た目を用意しておらず、スキップリンク/遷移後にフォーカスが移っても
              画面上に何も変化が見えなかった (CLAUDE.md §7 の「outline を消す場合は
              代替の見た目を用意する」に反する)。既定のブラウザアウトラインの代わりに
              focus-visible:ring-2 (TicketFilters 等と同じ teal 系のフォーカスリング) を
              明示的に用意した。focus-visible を使うのは、programmatic focus() やキーボード
              操作時にのみ視覚的に表示し、マウス操作の副作用で毎回リングが出ないようにするため */}
          <main
            id={MAIN_CONTENT_ID}
            tabIndex={-1}
            className="flex-1 overflow-y-auto p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 sm:p-6 md:p-8"
          >
            {children}
          </main>
          {/* §6.1 料金プラン「Free: ロゴ表示」。Free プラン (トライアル中を除く) のテナントにのみ表示する。
              text-slate-500 (背景 white 比でコントラスト比 約4.6:1) で WCAG AA (通常文 4.5:1) を満たす
              (slate-400 は約2.56:1 で未達だったため修正) */}
          {plan === 'free' && (
            <footer className="shrink-0 border-t border-slate-100 bg-white px-4 py-1.5 text-center text-xs text-slate-500">
              Powered by HelpDesk Hub
            </footer>
          )}
        </div>
      </div>
    </MobileNavProvider>
  );
}
