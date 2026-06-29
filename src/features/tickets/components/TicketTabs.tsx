'use client';

// クライアント遷移付きリンク
import Link from 'next/link';
// 現在 URL のクエリパラメータを読み取るフック (アクティブタブ判定用)
import { useSearchParams } from 'next/navigation';

// 共有型ファイルから import してこのモジュール内で型として使えるようにする
import type { TicketTabId } from '@/features/tickets/types';
// 後方互換のため TicketTabs.tsx からも re-export する (他ファイルが TicketTabs から import しても動くようにする)
export type { TicketTabId } from '@/features/tickets/types';

// タブ 1 つ分の表示メタ
interface TabDef {
  id: TicketTabId;
  label: string;
}

// 並べるタブの一覧 (Pivot plan §3.1「自分の未対応 / 期限切れ・今日まで」相当)
const TABS: TabDef[] = [
  { id: 'all', label: 'すべて' },
  { id: 'mine', label: '自分の未対応' },
  { id: 'overdue', label: '期限切れ' },
];

// 受け取る props (なし — 状態は URL クエリから読むため)
// 一覧ページ /tickets の上に水平方向に並ぶタブナビゲーションを描画する
export function TicketTabs() {
  // 現在の URL クエリ (?tab=... を読み取って active 判定に使う)
  const searchParams = useSearchParams();
  // 現在のタブ ID。未指定 / 不正値は 'all' にフォールバック
  const currentRaw = searchParams.get('tab');
  const current: TicketTabId = (TABS.some((t) => t.id === currentRaw) ? currentRaw : 'all') as TicketTabId;

  // 指定タブへ遷移するための URL を組み立てるヘルパー
  // - tab パラメータだけ差し替え、他のクエリ (q など) は維持する
  // - タブを切り替えると検索結果のページ番号 (page) はリセットする
  function tabHref(tabId: TicketTabId): string {
    // 既存クエリを複製
    const params = new URLSearchParams(searchParams.toString());
    // 'all' は既定なのでクエリから削る (URL を綺麗に保つ)
    if (tabId === 'all') {
      params.delete('tab');
    } else {
      params.set('tab', tabId);
    }
    // タブ切替時は page を必ず先頭に戻す
    params.delete('page');
    // クエリが空なら "?" は付けない
    const qs = params.toString();
    return qs ? `/tickets?${qs}` : '/tickets';
  }

  return (
    // タブナビ本体: 横並び、下線でアクティブを強調する一般的なタブ UI
    <nav className="flex gap-1 border-b border-slate-200 text-sm" aria-label="一覧の絞り込みタブ">
      {TABS.map((tab) => {
        // この項目がアクティブかどうか
        const isActive = tab.id === current;
        return (
          <Link
            key={tab.id}
            href={tabHref(tab.id)}
            // アクティブな項目はティールの下線で強調、非アクティブは控えめなグレー
            className={`-mb-px border-b-2 px-3 py-2.5 font-medium transition-colors ${
              isActive
                ? 'border-teal-600 text-teal-800'
                : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
            }`}
            // 現在のページかどうかを支援技術に伝える
            aria-current={isActive ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
