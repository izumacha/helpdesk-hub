'use client';

// 現在パスの変化を検知するための Next.js フックと、初回マウント判定用の ref フック
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

// CLAUDE.md §7 a11y: 「SPA でページ遷移したらフォーカスを新ページの先頭 (main 等) へ移す」。
// Next.js App Router のクライアントサイド遷移 (Link 経由) はブラウザの通常のページ遷移と異なり、
// フォーカスを暗黙にリセットしない。ページ遷移後もフォーカスが遷移前の要素 (例: サイドバーの
// リンク) に残り続け、スクリーンリーダー利用者は新しいページの内容に気づけない。
// 遷移のたびに #main-content (SkipLink の遷移先と共通) へフォーカスを移す。
export function RouteFocusManager() {
  // 現在の URL パス (クライアントサイド遷移のたびに変わる)
  const pathname = usePathname();
  // 初回マウント (＝実際のページロード。ブラウザが自然にフォーカスを扱うため対象外) かどうかの判定用
  const isFirstRender = useRef(true);

  useEffect(() => {
    // 初回マウント時はフォーカスを奪わない (通常のページロードの挙動を尊重する)
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    // 2 回目以降 (＝クライアントサイド遷移) はメインコンテンツの先頭にフォーカスを移す
    document.getElementById('main-content')?.focus();
  }, [pathname]);

  // 画面には何も描画しない (副作用のみのコンポーネント)
  return null;
}
