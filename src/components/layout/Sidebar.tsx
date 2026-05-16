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
// モバイルナビ Context (ハンバーガーで開閉するドロワー状態)
import { useMobileNav } from './MobileNavProvider';

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

// 左サイドバー (折りたたみ + 役割別メニュー出し分け + モバイルドロワー)
export function Sidebar({ role }: Props) {
  // 現在の URL パス (アクティブ強調に使う)
  const pathname = usePathname();
  // デスクトップ向けの折りたたみ状態 (true で幅を縮める)。モバイル開閉とは直交
  const [collapsed, setCollapsed] = useState(false);
  // モバイルドロワーの開閉状態と「閉じる」関数を Context から取得
  // (md 未満ではこの open に従って画面外/画面内へスライドする)
  const { open: mobileOpen, closeNav } = useMobileNav();

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
    // ラッパー: モバイル時のバックドロップ + ドロワーを内包する
    // (デスクトップでは何もせずサイドバーをそのまま左端に配置)
    <>
      {/* モバイル用の背景オーバーレイ: 開いている時のみ表示し、押下で閉じる */}
      {mobileOpen && (
        <div
          // 半透明の黒で背面を覆い、ドロワー以外を視覚的に分離する
          className="fixed inset-0 z-30 bg-slate-900/30 backdrop-blur-sm md:hidden"
          // 押下で閉じる (背景クリックで閉じる一般的な UX)
          onClick={closeNav}
          // 支援技術には装飾要素として無視させる
          aria-hidden="true"
        />
      )}
      {/* 折りたたみで幅を切り替えるサイドバー本体 (柔らかな白 + 右ボーダー)
          - md 未満: fixed 配置 + translate-x でスライドイン/アウト (mobileOpen 連動)
          - md 以上: relative 配置 + 常時表示 (collapsed で幅切替) */}
      <aside
        // モバイルドロワー時に MobileNavToggle の aria-controls から参照される ID
        id="mobile-sidebar"
        className={`fixed inset-y-0 left-0 z-40 flex flex-col border-r border-slate-200 bg-white/95 backdrop-blur transition-all duration-200 md:relative md:translate-x-0 ${
          // モバイル時の表示/非表示制御 (true = 画面内, false = 画面外左)
          mobileOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
        } ${
          // 幅切替: モバイルではフル幅相当 (w-64) を確保、md 以上は collapsed に応じて w-14/w-60 を切替
          collapsed ? 'w-64 md:w-14' : 'w-64 md:w-60'
        }`}
        // モバイルナビゲーションを意味するランドマーク
        aria-label="メインナビゲーション"
      >
        {/* ヘッダー領域 (ブランドマーク + 折りたたみボタン) */}
        <div className="flex h-16 items-center justify-between border-b border-slate-200 px-3">
          {/* 折りたたみ時はワードマークを隠し、シンボルだけ表示
              (モバイル時は collapsed の値に関わらずワードマーク表示にしたいので md 未満は常に true 相当扱い)
              ここでは showWordmark に !collapsed を渡し、デスクトップ折りたたみ時のみ非表示にする */}
          <Logo showWordmark={!collapsed} size={collapsed ? 28 : 30} />
          {/* 折りたたみ切り替えボタン (md 以上でのみ表示。モバイルでは Header のハンバーガーが担当) */}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="ml-auto hidden rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 md:block"
            aria-label={collapsed ? 'サイドバーを展開' : 'サイドバーを折りたたむ'}
          >
            {collapsed ? '›' : '‹'}
          </button>
        </div>
        {/* 折りたたみ時はメニュー本体を非表示 (デスクトップのみ。モバイルではドロワー幅 w-64 で常に展開表示) */}
        {!collapsed && (
          <nav className="flex-1 space-y-1 px-3 py-5">
            {visibleItems.map((item) => {
              // この項目が現在のページかどうか
              const isActive = isItemActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  // メニュータップで遷移と同時にモバイルドロワーを閉じる
                  // (Provider 側の useEffect で pathname を監視するとリンタが set-state-in-effect 警告を出すため、
                  //  ユーザー操作起点で明示的に閉じる方が安全)
                  onClick={closeNav}
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
    </>
  );
}
