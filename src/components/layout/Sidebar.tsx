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
// 共通ブランドマーク
import { Logo } from '@/components/brand/Logo';

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
    // 折りたたみで幅を切り替えるサイドバー本体 (柔らかな白 + 右ボーダー)
    <aside
      className={`flex flex-col border-r border-slate-200 bg-white/90 backdrop-blur transition-all duration-200 ${collapsed ? 'w-14' : 'w-60'}`}
    >
      {/* ヘッダー領域 (ブランドマーク + 折りたたみボタン) */}
      <div className="flex h-16 items-center justify-between border-b border-slate-200 px-3">
        {/* 折りたたみ時はワードマークを隠し、シンボルだけ表示 */}
        <Logo showWordmark={!collapsed} size={collapsed ? 28 : 30} />
        {/* 折りたたみ切り替えボタン (アイコン文字で軽量に) */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="ml-auto rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          aria-label={collapsed ? 'サイドバーを展開' : 'サイドバーを折りたたむ'}
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>
      {/* 折りたたみ時はメニュー本体を非表示 */}
      {!collapsed && (
        <nav className="flex-1 space-y-1 px-3 py-5">
          {visibleItems.map((item) => {
            // この項目が現在のページかどうか
            const isActive = isItemActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                // アクティブ項目はティールで強調 (左にバー風アクセント)
                className={`relative block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-teal-50 text-teal-800 ring-1 ring-teal-100 before:absolute before:top-1/2 before:left-0 before:h-5 before:w-1 before:-translate-y-1/2 before:rounded-r before:bg-teal-600'
                    : 'text-slate-600 hover:bg-teal-50/60 hover:text-teal-800'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      )}
      {/* フッター: 折りたたみ時以外は小さなバージョン情報風テキスト */}
      {!collapsed && (
        <div className="border-t border-slate-200 px-4 py-3 text-[11px] text-slate-400">
          © HelpDesk Hub
        </div>
      )}
    </aside>
  );
}
