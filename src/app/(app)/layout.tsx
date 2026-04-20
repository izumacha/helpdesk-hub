// 現在のセッション (ログイン情報) 取得
import { auth } from '@/lib/auth';
// 上部ヘッダー
import { Header } from '@/components/layout/Header';
// 左サイドバー
import { Sidebar } from '@/components/layout/Sidebar';

// (app) Route Group の共通レイアウト (認証後の画面骨格)
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // セッション取得 (middleware で未ログインは弾かれている前提)
  const session = await auth();
  // ロール (権限) を取得。万一未取得なら最弱権限の requester にフォールバック
  const role = session?.user?.role ?? ('requester' as const);

  return (
    // 画面全体: 左右レイアウト + 縦スクロール抑止
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {/* サイドバー (権限に応じてメニューを出し分け) */}
      <Sidebar role={role} />
      {/* 右側: ヘッダー + メインコンテンツ */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        {/* 各ページの内容 (縦スクロール可) */}
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
