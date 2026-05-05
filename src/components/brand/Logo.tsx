// ロゴが受け取る props (サイズとワードマーク表示の有無)
interface LogoProps {
  // ワードマーク (HelpDesk Hub) を出すかどうか。サイドバー折畳時は false
  showWordmark?: boolean;
  // シンボル部分の 1 辺サイズ (px)。既定 32
  size?: number;
  // 任意の追加クラス (外側ラッパーに適用)
  className?: string;
}

// HelpDesk Hub のブランドマーク (ティールの円弧 + ハート + プラス記号)
// 健診センター/病院を想起させる清潔感のあるシンボル。Sidebar / Login で再利用。
export function Logo({ showWordmark = true, size = 32, className = '' }: LogoProps) {
  return (
    // シンボルとワードマークを横並びにするフレックスコンテナ
    <div className={`flex items-center gap-2.5 ${className}`}>
      {/* シンボル本体 (SVG)。viewBox は 32x32 に正規化 */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        // アクセシビリティ用ラベル (装飾扱い)
        aria-hidden="true"
      >
        {/* 背景の角丸スクエア (ブランドティール) */}
        <rect width="32" height="32" rx="8" fill="var(--color-brand-700)" />
        {/* 中央のハート + プラス記号 (白抜き) */}
        {/* 縦のバー (プラス記号の縦) */}
        <rect x="14.5" y="9" width="3" height="14" rx="1.5" fill="white" />
        {/* 横のバー (プラス記号の横) */}
        <rect x="9" y="14.5" width="14" height="3" rx="1.5" fill="white" />
        {/* 上に被せる小さな円 (脈拍/医療を示唆) */}
        <circle cx="16" cy="16" r="2" fill="var(--color-brand-700)" />
      </svg>
      {/* ワードマーク (折畳時は非表示) */}
      {showWordmark && (
        <span className="text-base font-semibold tracking-tight text-slate-900">HelpDesk Hub</span>
      )}
    </div>
  );
}
