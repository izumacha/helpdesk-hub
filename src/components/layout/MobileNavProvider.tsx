'use client';

// React の Context 機能と状態フック・コールバック型を取り込む
import { createContext, useCallback, useContext, useEffect, useState } from 'react';

// モバイルナビゲーション (サイドバードロワー) の開閉状態と操作関数の契約
interface MobileNavContextValue {
  // 現在ドロワーが開いているか (true で開いている)
  open: boolean;
  // ドロワーを開く関数
  openNav: () => void;
  // ドロワーを閉じる関数
  closeNav: () => void;
  // 開閉を反転させる関数 (ハンバーガーボタン用)
  toggleNav: () => void;
}

// Context 本体 (初期値は undefined にしておき、Provider 外利用時に検知できるようにする)
const MobileNavContext = createContext<MobileNavContextValue | undefined>(undefined);

// Provider コンポーネント: アプリ全体 (認証後レイアウト) をラップしてドロワー状態を共有する
export function MobileNavProvider({ children }: { children: React.ReactNode }) {
  // ドロワーの開閉状態を持つ (初期値は閉じている)
  const [open, setOpen] = useState(false);

  // 「開く」関数: open を true に変更する (useCallback で再生成を抑制)
  const openNav = useCallback(() => setOpen(true), []);
  // 「閉じる」関数: open を false に変更する
  // (ページ遷移時に閉じる挙動は Sidebar 側の Link onClick から呼び出して実現する。
  //  ここで pathname を effect 監視すると set-state-in-effect 警告になるため)
  const closeNav = useCallback(() => setOpen(false), []);
  // 「切替」関数: 現在値を反転させる (前回値から true/false を反転)
  const toggleNav = useCallback(() => setOpen((prev) => !prev), []);

  // 開いている間は背面のスクロールを止める (ドロワーだけが動く UX に揃える)
  useEffect(() => {
    // 元の overflow 値を保存しておく (アンマウント時に復元するため)
    const originalOverflow = document.body.style.overflow;
    // 開いている場合のみ body のスクロールを止める
    if (open) {
      document.body.style.overflow = 'hidden';
    }
    // クリーンアップ: アンマウントまたは open 変化時に元の値に戻す
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [open]);

  // 子に対して状態と操作関数を渡す
  return (
    <MobileNavContext.Provider value={{ open, openNav, closeNav, toggleNav }}>
      {children}
    </MobileNavContext.Provider>
  );
}

// Context を参照するためのカスタムフック
// Provider 外で呼ばれた場合は明示的にエラーにして検出を早める
export function useMobileNav(): MobileNavContextValue {
  // Context を取得
  const ctx = useContext(MobileNavContext);
  // Provider にラップされていない場所からの呼び出しを禁止する
  if (!ctx) {
    throw new Error('useMobileNav は MobileNavProvider の子要素でのみ利用できます');
  }
  // 取得した値を返す
  return ctx;
}
