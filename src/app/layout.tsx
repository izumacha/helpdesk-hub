// HTML <head> 用メタデータの型 (Next.js)
import type { Metadata } from 'next';
// Noto Sans JP (Google Fonts) を Next.js 経由で読み込み
import { Noto_Sans_JP } from 'next/font/google';
// Tailwind を含むグローバル CSS を読み込む
import './globals.css';

// Noto Sans JP の読み込み定義 (CSS 変数 --font-noto-sans-jp として注入)
const notoSansJp = Noto_Sans_JP({
  // 通常 / 中 / 半太 / 太の 4 ウェイトを取得 (UI で過不足ない範囲)
  weight: ['400', '500', '600', '700'],
  // 日本語 (latin も含む) のサブセットを指定
  subsets: ['latin'],
  // 読み込み完了までフォールバックフォントを表示する (Layout Shift 抑制)
  display: 'swap',
  // CSS 変数名を固定 (globals.css の --font-sans から参照)
  variable: '--font-noto-sans-jp',
});

// ブラウザのタブタイトル/説明などを定義 (Next.js が <head> に出力)
export const metadata: Metadata = {
  title: 'HelpDesk Hub',
  description: '問い合わせ管理システム',
};

// アプリ全体のルートレイアウト (HTML/BODY を組み立てる)
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // 言語を日本語に設定 + Noto Sans JP の CSS 変数を <html> に付与
    <html lang="ja" className={notoSansJp.variable}>
      {/* 子要素 (各ページ) を body 内にそのまま描画 */}
      <body>{children}</body>
    </html>
  );
}
