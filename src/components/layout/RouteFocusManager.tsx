'use client';

// 現在パスの変化を検知するための Next.js フックと、初回パス記憶用の ref フック
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
// (app) レイアウトの <main> に振った id の単一の参照元 (§6 マジック文字列を避ける)
import { MAIN_CONTENT_ID } from '@/components/layout/main-content-id';

// CLAUDE.md §7 a11y: 「SPA でページ遷移したらフォーカスを新ページの先頭 (main 等) へ移す」。
// Next.js App Router のクライアントサイド遷移 (Link 経由) はブラウザの通常のページ遷移と異なり、
// フォーカスを暗黙にリセットしない。ページ遷移後もフォーカスが遷移前の要素 (例: サイドバーの
// リンク) に残り続け、スクリーンリーダー利用者は新しいページの内容に気づけない。
// 遷移のたびに #main-content (SkipLink の遷移先と共通) へフォーカスを移す。
//
// 対象範囲について: usePathname() はクエリ文字列 (検索パラメータ) の変化には反応しない
// (パス部分のみを返す)。TicketFilters.tsx の絞り込みプルダウンはクエリ文字列のみを書き換える
// 遷移のため、この副作用は発火しない。これは意図的な範囲限定であり不具合ではない ―
// 絞り込み操作は利用者自身がその場でセレクトを操作した直後であり、そこからフォーカスを
// 本文へ強制的に奪うことは WCAG 3.2.1/3.2.2 が禁じる「利用者の入力による予期しない
// コンテキスト変化」に該当しうるため、ここでは実際のページ遷移 (パス変化) のみを対象にする。
export function RouteFocusManager() {
  // 現在の URL パス (クライアントサイド遷移のたびに変わる)
  const pathname = usePathname();
  // マウント時点のパスを 1 度だけ記憶する ref。
  // フォローアップ (2026-07-16 #2 レビュー対応): 当初は useEffect 内で
  // `isFirstRender.current = false` と代入するフラグ方式だったが、React の
  // Strict Mode (開発時、Next.js App Router は既定で有効) は副作用を
  // マウント→クリーンアップ→再マウントの順で 2 回連続実行するため、
  // 1 回目の実行でフラグが false に書き換わった直後に 2 回目が実行され、
  // 「初回マウント時はフォーカスを奪わない」という意図に反して初回ロード時にも
  // focus() が呼ばれてしまっていた。ref の初期値としてマウント時のパスをそのまま
  // 記憶し、以降は「現在のパスが記憶した初期パスと異なるか」だけで判定することで、
  // 副作用側で状態を書き換えない (Strict Mode の 2 回実行でも判定結果が変わらない)
  // 実装に変更した。
  const initialPathname = useRef(pathname);

  useEffect(() => {
    // 現在のパスが初期パスと同じ (＝まだ実際のページ遷移が起きていない) ならフォーカスを奪わない
    if (pathname === initialPathname.current) {
      return;
    }
    // パスが変わった (＝クライアントサイド遷移が起きた) 場合のみメインコンテンツへフォーカスを移す
    document.getElementById(MAIN_CONTENT_ID)?.focus();
  }, [pathname]);

  // 画面には何も描画しない (副作用のみのコンポーネント)
  return null;
}
