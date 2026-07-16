'use client';

// (app) レイアウトの <main> に振った id の単一の参照元 (§6 マジック文字列を避ける)
import { MAIN_CONTENT_ID } from '@/components/layout/main-content-id';

// CLAUDE.md §7 a11y: 「本文へ飛ぶスキップリンク」。キーボード利用者がヘッダー/サイドバーの
// ナビゲーションを毎ページ読み上げ/Tab移動せずに本文 (#main-content) へ直接移動できるようにする。
// 通常は視覚的に隠し (sr-only)、フォーカスを受けたときだけ表示する定番パターン。
export function SkipLink() {
  // クリック時に本文へ明示的にフォーカスを移す関数
  // (Safari/VoiceOver はページ内フラグメントリンクのクリックでスクロールはするが、
  // 対象要素が tabIndex={-1} でもフォーカスは移動しない既知の挙動があるため、
  // href によるネイティブなフラグメント遷移だけに頼らず、明示的に focus() を呼んで
  // Chromium/Firefox/Safari のいずれでも確実にフォーカスが移るようにする)
  function handleClick() {
    // 本文要素を id で取得する (見つからない場合は何もしない)
    document.getElementById(MAIN_CONTENT_ID)?.focus();
  }

  // スキップリンク本体を返す
  return (
    // href は通常のフラグメント遷移として残しつつ (JS 無効時のフォールバック)、
    // onClick で明示的な focus() も併用する
    <a
      href={`#${MAIN_CONTENT_ID}`}
      onClick={handleClick}
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-teal-700 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:ring-2 focus:ring-teal-500/30 focus:outline-none"
    >
      {/* リンクの可視テキスト (通常は sr-only で隠れる) */}
      本文へスキップ
    </a>
  );
}
