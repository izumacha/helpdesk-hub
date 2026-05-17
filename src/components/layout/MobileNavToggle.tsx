'use client';

// モバイルナビ Context (ドロワー開閉状態) を取り出すためのフック
import { useMobileNav } from './MobileNavProvider';

// ヘッダー左端に表示するハンバーガーボタン
// - md (768px) 以上では非表示 (デスクトップは Sidebar が常時見えている)
// - md 未満では押下でドロワーを開閉する
export function MobileNavToggle() {
  // Context からドロワー状態と切替関数を取り出す
  const { open, toggleNav } = useMobileNav();

  return (
    <button
      type="button"
      // ハンバーガーボタン本体: md 以上では非表示、軽量な丸角ボタン
      className="-ml-1 inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 md:hidden"
      // 押下でドロワーを開閉する
      onClick={toggleNav}
      // 現在の状態を支援技術にも伝える (展開済みかどうか)
      aria-expanded={open}
      // 操作対象のドロワー要素 ID (Sidebar 側で同じ id を付与する)
      aria-controls="mobile-sidebar"
      // スクリーンリーダー向けのラベル (開閉状態に応じて表記を切替)
      aria-label={open ? 'メニューを閉じる' : 'メニューを開く'}
    >
      {/* 開いているときは X 印、閉じているときはハンバーガーアイコンを SVG で描画 */}
      {open ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* X 印 (閉じるアイコン): 左上→右下 + 右上→左下 の 2 本線 */}
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* ハンバーガーアイコン: 上中下の 3 本横線 */}
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      )}
    </button>
  );
}
