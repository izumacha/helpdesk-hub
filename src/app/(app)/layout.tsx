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

// (app) Route Group の共通レイアウト (認証後の画面骨格)
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // セッション取得 (middleware で未ログインは弾かれている前提)
  const session = await auth();
  // ロール (権限) を取得。万一未取得なら最弱権限の requester にフォールバック
  const role = session?.user?.role ?? ('requester' as const);
  // テナントの動作モード (lite | pro) を取得し、メニュー出し分けに使う
  // (tenantId を渡して二重 session 読み込みを回避。未ログイン時は既定 lite)
  const mode = await getCurrentTenantMode(session?.user?.tenantId);

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
        </div>
      </div>
    </MobileNavProvider>
  );
}
