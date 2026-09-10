'use client';

// React の状態フック (折りたたみ状態) / 参照フック (ドロワー DOM) / 副作用フック (キー操作の購読)
import { useEffect, useRef, useState } from 'react';
// クライアント遷移付きリンク
import Link from 'next/link';
// 現在の URL パスを取得 (アクティブ判定に使用)
import { usePathname } from 'next/navigation';
// 「エージェント以上か」を判定するヘルパー
import { isAgent } from '@/lib/role';
// 権限・テナントモードを表すドメイン型 (正準)
import type { Role, TenantMode } from '@/domain/types';
// 「FAQ 候補」機能の呼称を mode に応じて切り替える定数 (§6 一元管理)
import { FAQ_TERM_LABELS } from '@/lib/constants';
// 共通ブランドマーク
import { Logo } from '@/components/brand/Logo';
// メニュー項目のアクティブ判定 (React/Next 非依存の純粋関数。単体テスト可能なため切り出し済み)
import { isItemActive } from '@/lib/nav-active';
// モバイルナビ Context (ハンバーガーで開閉するドロワー状態)
import { useMobileNav } from './MobileNavProvider';

// サイドバーが受け取る props (現在のロールとテナントモード)
interface Props {
  role: Role;
  mode: TenantMode;
}

// メニュー項目定義
// - agentOnly: エージェント以上 (agent / admin) のみ表示
// - adminOnly: 管理者 (admin) のみ表示 (テナント設定など組織管理向け)
// - label: 固定文言、または mode に応じて表示文言を変える関数
//   (§1.1 フォローアップ: FAQ 候補は Lite でも「よくある質問」として使える機能のため、
//    以前の proOnly による非表示をやめ、呼称だけ mode で切り替える)
const navItems: {
  href: string;
  label: string | ((mode: TenantMode) => string);
  agentOnly?: boolean;
  adminOnly?: boolean;
}[] = [
  { href: '/dashboard', label: 'ダッシュボード' },
  { href: '/tickets', label: '問い合わせ一覧' },
  { href: '/tickets/new', label: '新規登録' },
  // フォローアップ (2026-07-14 #5): 依頼者は公開済み FAQ を閲覧できる (agentOnly ではなくなった)。
  // /faq ページ自体がロールで「候補管理ビュー」「公開済み閲覧ビュー」を出し分ける
  { href: '/faq', label: (mode) => FAQ_TERM_LABELS[mode] },
  { href: '/notifications', label: '通知' },
  { href: '/settings/line', label: 'LINE連携' }, // Phase 2: 自分の LINE を連携する自己サービス (全ロール)
  { href: '/audit', label: '監査ログ', adminOnly: true }, // Phase 4: 管理者向け変更履歴
  { href: '/quarantine', label: '隔離メール', adminOnly: true }, // §3.2 フォローアップ: 隔離した受信メール一覧
  { href: '/settings', label: '設定', adminOnly: true },
  { href: '/help', label: 'ヘルプ' }, // Phase 3: ヘルプセンター (全ロール表示)
];

// 左サイドバー (折りたたみ + 役割別メニュー出し分け + モバイルドロワー)
export function Sidebar({ role, mode }: Props) {
  // 現在の URL パス (アクティブ強調に使う)
  const pathname = usePathname();
  // デスクトップ向けの折りたたみ状態 (true で幅を縮める)。モバイル開閉とは直交
  const [collapsed, setCollapsed] = useState(false);
  // モバイルドロワーの開閉状態と「閉じる」関数を Context から取得
  // (md 未満ではこの open に従って画面外/画面内へスライドする)
  const { open: mobileOpen, closeNav } = useMobileNav();
  // ドロワー本体の DOM 参照 (フォーカストラップの範囲を決めるのに使う)
  const asideRef = useRef<HTMLDivElement>(null);

  // モバイルドロワーのキーボード対応 (§7 a11y「モーダルはフォーカストラップ + Esc で閉じ」)。
  // 監査フォローアップ (2026-09-09): 以前は Esc で閉じられず、Tab で背面のコンテンツへ
  // フォーカスが抜けてしまい、キーボード利用者はドロワーを閉じる手段が事実上なかった
  useEffect(() => {
    // 閉じているあいだは何もしない (リスナーも張らない)
    if (!mobileOpen) return;
    // md 以上ではドロワーではなく常設サイドバーとして表示されるため、トラップは掛けない
    // (掛けるとデスクトップでページ全体のキーボード操作を奪ってしまう)
    const mdQuery = window.matchMedia('(min-width: 768px)');
    if (mdQuery.matches) return;
    // ドロワーの DOM が取れなければ何もできない (次の描画で再実行される)。
    // リスナー登録より前に判定する (登録後に早期 return するとクリーンアップが返らず
    // リスナーが残留するため §8)
    const aside = asideRef.current;
    if (!aside) return;
    // 開いたまま画面幅が md 以上へ変わった場合 (タブレットの回転・ウィンドウのリサイズ) は
    // ドロワー状態ごと閉じる (/code-review ultra 指摘対応: 判定を開いた瞬間の 1 回で
    // 固定すると、常設サイドバーに切り替わった後もトラップと背面スクロール禁止が残り、
    // キーボード利用者が本文へ戻れなくなる)。閉じれば本 effect のクリーンアップが走り、
    // トラップ解除・フォーカス復元・MobileNavProvider 側のスクロール解放が連動する
    const onBreakpointChange = (event: MediaQueryListEvent) => {
      if (event.matches) closeNav();
    };
    mdQuery.addEventListener('change', onBreakpointChange);
    // 開く前にフォーカスしていた要素 (通常はハンバーガーボタン) を覚えておき、閉じたら戻す
    const previouslyFocused = document.activeElement;
    // ドロワー内の「見えていて」フォーカス可能な要素一覧を返すヘルパー。
    // offsetParent が null の要素 (display:none。md 専用の折りたたみボタン等) は
    // フォーカスできないため除外する
    const focusables = () =>
      Array.from(aside.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')).filter(
        (el) => el.offsetParent !== null,
      );
    // 開いた直後にフォーカスをドロワー内の先頭要素へ移す (背面に取り残さない)
    focusables()[0]?.focus();
    // キー操作のハンドラ (Esc で閉じる / Tab をドロワー内で循環させる)
    const onKeyDown = (event: KeyboardEvent) => {
      // Esc: ドロワーを閉じる
      if (event.key === 'Escape') {
        closeNav();
        return;
      }
      // Tab 以外のキーはトラップ対象外
      if (event.key !== 'Tab') return;
      // 現時点のフォーカス可能要素一覧 (0 件なら何もしない)
      const items = focusables();
      if (items.length === 0) return;
      // 先頭・末尾の要素を取り出す
      const first = items[0];
      const last = items[items.length - 1];
      // フォーカスがドロワーの外にある場合 (ドロワー内の非対話領域をタップして
      // activeElement が body に落ちた直後など) は、Tab の行き先が背面のコンテンツに
      // なってしまうため、必ずドロワー内へ引き戻す (/code-review ultra 指摘対応)
      if (!aside.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      // Shift+Tab で先頭から抜けようとしたら末尾へ回す
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        // Tab で末尾から抜けようとしたら先頭へ回す
        event.preventDefault();
        first.focus();
      }
    };
    // キー操作の購読を開始する
    document.addEventListener('keydown', onKeyDown);
    // クリーンアップ: 購読を解除し、フォーカスを開く前の要素へ戻す (§8 リソース解放)
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // ブレークポイント監視も忘れずに解除する
      mdQuery.removeEventListener('change', onBreakpointChange);
      // 覚えておいた要素がまだフォーカス可能ならそこへ戻す
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [mobileOpen, closeNav]);

  // 権限に応じて表示できる項目だけに絞り込む
  // 1 項目に複数の制約が付きうるため、各制約を個別に判定し
  // どれか 1 つでも満たさなければ隠す (早期 return で「いずれか不適合なら除外」を表現)
  const visibleItems = navItems.filter((item) => {
    // adminOnly 項目は admin ロール以外には表示しない
    if (item.adminOnly && role !== 'admin') return false;
    // agentOnly 項目は agent / admin 以外には表示しない
    if (item.agentOnly && !isAgent(role)) return false;
    // すべての制約を満たした項目だけ表示する
    return true;
  });
  // メニュー全項目の href 一覧 (デュアルハイライト防止の prefix マッチ判定に使う)
  const navHrefs = navItems.map((item) => item.href);

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
      <div
        // フォーカストラップの範囲を決める DOM 参照 (上の useEffect が使う)
        ref={asideRef}
        // モバイルドロワー時に MobileNavToggle の aria-controls から参照される ID
        id="mobile-sidebar"
        className={`fixed inset-y-0 left-0 z-40 flex flex-col border-r border-slate-200 bg-white/95 backdrop-blur transition-all duration-200 md:relative md:translate-x-0 ${
          // モバイル時の表示/非表示制御 (true = 画面内, false = 画面外左)
          mobileOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
        } ${
          // 幅切替: モバイルではフル幅相当 (w-64) を確保、md 以上は collapsed に応じて w-14/w-60 を切替
          collapsed ? 'w-64 md:w-14' : 'w-64 md:w-60'
        }`}
        // モバイルドロワーとして開いているあいだだけ「モーダルダイアログ」として扱う
        // (/code-review ultra 指摘対応 2026-09-10)。Tab のフォーカストラップだけでは
        // **スクリーンリーダーの仮想カーソル**は止められず、スワイプ/矢印キーで読み進めた
        // 利用者は最後のナビ項目の先で背面のチケット一覧 — 視覚的にはオーバーレイで
        // 覆われて操作もできない領域 — へ、メニューを出たことに気づかないまま入ってしまう。
        // aria-modal="true" は「このダイアログの外は今は無いものとして扱う」という指示で、
        // 支援技術側が仮想カーソルの移動範囲をこの要素の中に閉じてくれる (WAI-ARIA APG の
        // モーダルダイアログの作法。フォーカストラップと対で初めて成立する)。
        // md 以上の常設サイドバー表示 (mobileOpen=false) では従来どおり
        // 補助的なランドマーク (complementary) のままにする — 常に dialog にすると
        // デスクトップでランドマーク単位の読み飛ばしができなくなるため。
        // /code-review ultra 指摘対応 (2026-09-10): 要素を <aside> から <div> に変えている。
        // ARIA in HTML は aside に dialog ロールを許しておらず (complementary / region /
        // note 等のみ)、そのままだと axe の aria-allowed-role で新規違反になるため。
        // <aside> の既定ロールは complementary なので、閉じているときに明示すれば等価
        role={mobileOpen ? 'dialog' : 'complementary'}
        aria-modal={mobileOpen ? true : undefined}
        // ランドマーク名 / ダイアログ名 (どちらの役割でも同じ呼び名を使う)
        aria-label="メインナビゲーション"
      >
        {/* ヘッダー領域 (ブランドマーク + 折りたたみボタン)
            ブランドマーク: モバイル (md 未満) では collapsed を無視して常にワードマーク表示し、
            md 以上でのみ collapsed に応じてシンボル化する。
            "hidden md:block" / "md:hidden" の併用で md ブレークポイントを境に切り替える */}
        <div className="flex h-16 items-center justify-between border-b border-slate-200 px-3">
          {/* モバイル: 常にワードマーク + 通常サイズ (collapsed の影響を受けない) */}
          <div className="md:hidden">
            <Logo showWordmark size={30} />
          </div>
          {/* デスクトップ: collapsed に応じてワードマーク表示・サイズを切り替える */}
          <div className="hidden md:block">
            <Logo showWordmark={!collapsed} size={collapsed ? 28 : 30} />
          </div>
          {/* 折りたたみ切り替えボタン (md 以上でのみ表示。モバイルでは下の閉じるボタンが担当) */}
          <button
            // 既定の type は submit なので明示する (将来サイドバーに <form> を足したとき、
            // 押下で意図しない送信が起きるのを防ぐ。MobileNavToggle と同じ理由)
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="ml-auto hidden rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 md:block"
            aria-label={collapsed ? 'サイドバーを展開' : 'サイドバーを折りたたむ'}
          >
            {collapsed ? '›' : '‹'}
          </button>
          {/* ドロワーを閉じるボタン (md 未満で、かつ開いているときだけ描画する)。
              /code-review ultra 指摘対応 (2026-09-10): aria-modal="true" は「このダイアログの
              外は無いものとして扱う」指示なので、Header にあるハンバーガー (唯一の閉じる操作) も
              支援技術から見えなくなる。ドロワー内に閉じる手段が無いと、Esc キーを持たない
              タッチ端末のスクリーンリーダー利用者 (iOS VoiceOver / TalkBack) は
              「どれかのメニュー項目をタップして意図しない画面へ移る」以外にメニューを出られない。
              WAI-ARIA APG がモーダルダイアログに dismiss コントロールを必須としているのはこのため。

              **mobileOpen で描画自体を切り替える** (2 巡目指摘対応): 閉じたドロワーは
              -translate-x-full で画面外へ出ているだけで display:none でも inert でもないため、
              常に描画すると「画面のどこにも見えないのに Tab で最初に到達し、押しても何も
              起きないボタン」がタブ順の先頭付近に居座る。
              ラベルを「ナビゲーションを閉じる」にしているのは、開いている間 Header の
              MobileNavToggle も「メニューを閉じる」になり、同名のボタンが 2 つできるため
              (読み上げで区別できず、Playwright の getByRole も strict mode violation になる) */}
          {mobileOpen && (
            <button
              type="button"
              onClick={closeNav}
              className="ml-auto rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 md:hidden"
              aria-label="ナビゲーションを閉じる"
            >
              {/* 視覚的な × 記号 (意味は上の aria-label が持つので読み上げからは外す) */}
              <span aria-hidden="true">✕</span>
            </button>
          )}
        </div>
        {/* メニュー本体は常に DOM に描画する。
            collapsed の効果は md 以上だけに限定 (md:hidden) し、モバイルでは必ず表示する。
            これにより「デスクトップで折りたたみ → 画面幅を縮める → ハンバーガーで開く」のフローで
            メニューが空になる不具合を防ぐ */}
        <nav className={`flex-1 space-y-1 px-3 py-5 ${collapsed ? 'md:hidden' : ''}`}>
          {visibleItems.map((item) => {
            // この項目が現在のページかどうか
            const isActive = isItemActive(pathname, item.href, navHrefs);
            // label が関数 (mode-aware) なら現在の mode で解決し、そうでなければそのまま使う
            const label = typeof item.label === 'function' ? item.label(mode) : item.label;
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
                {label}
              </Link>
            );
          })}
        </nav>
        {/* フッター: 同様にモバイルでは常時表示、md 以上でのみ collapsed の影響を受ける */}
        <div
          className={`border-t border-slate-200 px-4 py-3 text-[11px] text-slate-400 ${
            collapsed ? 'md:hidden' : ''
          }`}
        >
          © HelpDesk Hub
        </div>
      </div>
    </>
  );
}
