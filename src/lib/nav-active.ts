// サイドバーのメニュー項目が「現在表示中のページ」かどうかを判定する純粋関数。
// Next.js (usePathname) にも React にも依存しないため、Vitest の node 環境でそのまま
// ユニットテストできる (docs/pr-review-report.md §4 のフォローアップ「isItemActive のユニット
// テスト追加」に対応。ロジック自体は src/components/layout/Sidebar.tsx に元々インライン定義
// されていたものを、テスト容易性のためここへ切り出した。挙動は変更していない)。

// 現在の URL パス (pathname) が、メニュー項目の href に対して「アクティブ」とみなせるかを判定する。
// - href が "/" の場合は完全一致のみをアクティブとする (ルートを常時アクティブにしない)。
// - それ以外は完全一致、または「他のどのメニュー項目とも完全一致しない」前提での prefix 一致を
//   アクティブとする。navHrefs (メニュー全項目の href 一覧) を渡すのは、例えば /tickets/new を
//   表示中に /tickets 側を誤って一緒にアクティブ表示しない (デュアルハイライト防止) ため。
export function isItemActive(pathname: string, href: string, navHrefs: readonly string[]): boolean {
  // ルート "/" は完全一致のみをアクティブとする
  if (href === '/') return pathname === '/';
  // 完全一致なら即アクティブ
  if (pathname === href) return true;
  // 現在のパスに完全一致するメニュー項目が別に存在する場合は、prefix マッチを使わない
  // (例: /tickets/new 閲覧時に /tickets を誤ってアクティブにしない)
  const hasExactNavMatch = navHrefs.some((navHref) => navHref === pathname);
  // 完全一致する項目が無く、かつ "href/" で始まる場合のみ prefix マッチでアクティブとする
  return !hasExactNavMatch && pathname.startsWith(`${href}/`);
}
