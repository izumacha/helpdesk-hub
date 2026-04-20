// HTML <head> 用メタデータの型 (Next.js)
import type { Metadata } from 'next';
// Tailwind を含むグローバル CSS を読み込む
import './globals.css';

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
    // 言語を日本語に設定
    <html lang="ja">
      {/* 子要素 (各ページ) を body 内にそのまま描画 */}
      <body>{children}</body>
    </html>
  );
}
