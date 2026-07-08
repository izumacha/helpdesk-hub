// 現在のセッション (ログイン情報) 取得
import { auth } from '@/lib/auth';
// 上部ヘッダー
import { Header } from '@/components/layout/Header';
// 左サイドバー
import { Sidebar } from '@/components/layout/Sidebar';
// モバイル時のサイドバードロワー開閉状態を Header / Sidebar 間で共有する Provider
import { MobileNavProvider } from '@/components/layout/MobileNavProvider';
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
      {/* 画面全体: 左右レイアウト + 縦スクロール抑止 (背景は新トークン surface) */}
      <div className="bg-surface flex h-screen overflow-hidden">
        {/* サイドバー (権限とモードに応じてメニューを出し分け。md 未満は Provider 状態でドロワー化) */}
        <Sidebar role={role} mode={mode} />
        {/* 右側: ヘッダー + メインコンテンツ */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <Header />
          {/* 各ページの内容 (縦スクロール可) ─ モバイルは余白を控えめにする */}
          <main className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">{children}</main>
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
