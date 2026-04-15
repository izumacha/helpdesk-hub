'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isAgent } from '@/lib/role';
import type { Role } from '@/generated/prisma';

interface Props {
  role: Role;
}

const navItems = [
  { href: '/dashboard', label: 'ダッシュボード' },
  { href: '/tickets', label: '問い合わせ一覧' },
  { href: '/tickets/new', label: '新規登録' },
  { href: '/faq', label: 'FAQ候補', agentOnly: true },
  { href: '/notifications', label: '通知' },
];

export function Sidebar({ role }: Props) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  const visibleItems = navItems.filter((item) => !item.agentOnly || isAgent(role));
  const isItemActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <aside
      className={`flex flex-col border-r border-gray-200 bg-white transition-all duration-200 ${collapsed ? 'w-10' : 'w-56'}`}
    >
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-4">
        {!collapsed && (
          <span className="text-lg font-semibold text-gray-900">HelpDesk Hub</span>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="ml-auto rounded p-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
          aria-label={collapsed ? 'サイドバーを展開' : 'サイドバーを折りたたむ'}
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>
      {!collapsed && (
        <nav className="flex-1 space-y-1 px-3 py-4">
          {visibleItems.map((item) => {
            const isActive = isItemActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
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
