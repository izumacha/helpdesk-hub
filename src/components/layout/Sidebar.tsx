'use client';

// React の状態フック (折りたたみ状態を保持)
import { useState } from 'react';
// クライアント遷移付きリンク
import Link from 'next/link';
// 現在の URL パスを取得 (アクティブ判定に使用)
import { usePathname } from 'next/navigation';
// 「エージェント以上か」を判定するヘルパー
import { isAgent } from '@/lib/role';
// 権限を表す Prisma 型
import type { Role } from '@/generated/prisma';

// サイドバーが受け取る props (現在のロール)
interface Props {
  role: Role;
}

// メニュー項目定義 (agentOnly の項目はエージェント以上のみ表示)
const navItems = [
  { href: '/dashboard', label: 'ダッシュボード' },
  { href: '/tickets', label: '問い合わせ一覧' },
  { href: '/tickets/new', label: '新規登録' },
  { href: '/faq', label: 'FAQ候補', agentOnly: true },
  { href: '/notifications', label: '通知' },
];

// 左サイドバー (折りたたみ + 役割別メニュー出し分け)
export function Sidebar({ role }: Props) {
  // 現在の URL パス (アクティブ強調に使う)
  const pathname = usePathname();
  // 折りたたみ状態 (true で幅を縮める)
  const [collapsed, setCollapsed] = useState(false);

  // 権限に応じて表示できる項目だけに絞り込む
  const visibleItems = navItems.filter((item) => !item.agentOnly || isAgent(role));
  // メニュー項目がアクティブかどうかを判定 (完全一致 + 一部 prefix マッチ)
  const isItemActive = (href: string) => {
    // ルート "/" は完全一致のみ
    if (href === '/') return pathname === '/';
    // 完全一致なら即アクティブ
    if (pathname === href) return true;
    // nav item に完全一致するパスが存在する場合は prefix マッチを使わない
    // （例: /tickets/new 閲覧時に /tickets を誤ってアクティブにしない）
    const hasExactNavMatch = navItems.some((item) => item.href === pathname);
    return !hasExactNavMatch && pathname.startsWith(`${href}/`);
  };

  return (
    // 折りたたみで幅を切り替えるサイドバー本体
    <aside
      className={`flex flex-col border-r border-gray-200 bg-white transition-all duration-200 ${collapsed ? 'w-10' : 'w-56'}`}
    >
      {/* ヘッダー領域 (タイトル + 折りたたみボタン) */}
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-4">
        {/* 折りたたみ時はタイトルを隠す */}
        {!collapsed && (
          <span className="text-lg font-semibold text-gray-900">HelpDesk Hub</span>
        )}
        {/* 折りたたみ切り替えボタン */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="ml-auto rounded p-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
          aria-label={collapsed ? 'サイドバーを展開' : 'サイドバーを折りたたむ'}
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>
      {/* 折りたたみ時はメニュー本体を非表示 */}
      {!collapsed && (
        <nav className="flex-1 space-y-1 px-3 py-4">
          {visibleItems.map((item) => {
            // この項目が現在のページかどうか
            const isActive = isItemActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                // アクティブ項目は青で強調
                className={`block rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      )}
    </aside>
  );
}
