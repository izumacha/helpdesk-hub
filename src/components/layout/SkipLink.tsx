// CLAUDE.md §7 a11y: 「本文へ飛ぶスキップリンク」。キーボード利用者がヘッダー/サイドバーの
// ナビゲーションを毎ページ読み上げ/Tab移動せずに本文 (#main-content) へ直接移動できるようにする。
// 通常は視覚的に隠し (sr-only)、フォーカスを受けたときだけ表示する定番パターン。
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-teal-700 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:ring-2 focus:ring-teal-500/30 focus:outline-none"
    >
      本文へスキップ
    </a>
  );
}
