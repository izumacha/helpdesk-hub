import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'HelpDesk Hub',
  description: '問い合わせ管理システム',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
