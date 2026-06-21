// Next.js リンクコンポーネント (クライアントサイドナビゲーション)
import Link from 'next/link';
// ブランドマーク (ロゴ)
import { Logo } from '@/components/brand/Logo';

// ヘルプセンターのメタデータ (ブラウザタブに表示)
export const metadata = {
  title: 'ヘルプセンター | HelpDesk Hub',
  description: 'HelpDesk Hub の使い方ガイドとよくある質問',
};

// ヘルプセンター内の記事一覧 (ナビゲーション用)
const helpArticles = [
  { href: '/help', label: 'はじめに' },
  { href: '/help/getting-started', label: '30 分で運用開始する' },
  { href: '/help/tickets', label: '問い合わせの管理' },
  { href: '/help/email-integration', label: 'メールから問い合わせを取り込む' },
];

// ヘルプセンター全体のレイアウト (未認証でもアクセス可能な公開ページ)
// Phase 3「ヘルプセンター（このリポジトリ内に Next.js で同梱、SSG）」に対応
export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return (
    // 白背景の最小フルスクリーンレイアウト
    <div className="min-h-screen bg-slate-50">
      {/* ヘッダーバー: ロゴ + アプリへ戻るリンク */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
          {/* ロゴ (クリックでヘルプトップへ) */}
          <Link href="/help" aria-label="ヘルプセンタートップへ戻る">
            <Logo showWordmark size={28} />
          </Link>
          {/* アプリログイン導線 */}
          <Link
            href="/login"
            className="rounded-lg border border-teal-300 bg-white px-3 py-1.5 text-sm font-medium text-teal-800 transition hover:bg-teal-50"
          >
            ログイン
          </Link>
        </div>
      </header>

      {/* 本文エリア: サイドナビ + コンテンツ */}
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:flex lg:gap-8">
        {/* サイドナビゲーション (lg 以上で左カラム固定) */}
        <nav
          className="mb-6 shrink-0 lg:mb-0 lg:w-52"
          aria-label="ヘルプセンターのナビゲーション"
        >
          <ul className="space-y-1">
            {helpArticles.map((article) => (
              <li key={article.href}>
                <Link
                  href={article.href}
                  className="block rounded-lg px-3 py-2 text-sm text-slate-600 transition hover:bg-teal-50 hover:text-teal-800"
                >
                  {article.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* メインコンテンツ (記事本文) */}
        <main className="min-w-0 flex-1">
          {/* prose クラスで読みやすい記事スタイルを適用 */}
          <article className="rounded-2xl bg-white px-6 py-8 shadow-sm ring-1 ring-slate-100 sm:px-8">
            {children}
          </article>
        </main>
      </div>

      {/* フッター */}
      <footer className="mt-12 border-t border-slate-200 py-6 text-center text-xs text-slate-400">
        © HelpDesk Hub — 中小企業向けヘルプデスク管理システム
      </footer>
    </div>
  );
}
