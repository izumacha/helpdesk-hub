// Playwright のテスト DSL と Page 型
import { test, expect, Page } from '@playwright/test';
// E2E 共通のログインヘルパー (§6 DRY: スペックごとに書き写さない)
import { login } from './login';

// モバイル幅 (md 未満) のナビゲーションドロワーの挙動を検証する。
//
// このスペックが存在する理由 (消さないこと): ドロワーの a11y は 2026-09 のレビューで
// 3 巡続けて回帰を出した箇所で、いずれも **lint / typecheck / unit / contract のすべてが
// 緑のまま**通っていた。既定の Playwright プロジェクトは Desktop Chrome (1280px = md 以上) で、
// その幅では `md:visible` / `md:relative` がドロワーの仕組みごと覆い隠すため、
// mobile 幅で見るスペックが 1 本も無いと機構全体が無検証になる。
test.describe('モバイルのナビゲーションドロワー', () => {
  // このスペックだけ iPhone 相当の幅にする (プロジェクト設定は Desktop Chrome のまま)
  test.use({ viewport: { width: 375, height: 812 } });

  // 各テスト共通の前準備 (ログイン → チケット一覧を開く)
  test.beforeEach(async ({ page }) => {
    // エージェントでログインする
    await login(page);
    // チケット一覧を開く (ドロワーは閉じた状態が既定)
    await page.goto('/tickets');
  });

  // ドロワーを開くヘルパー。**ハイドレーション完了を待ってからクリックする**。
  // MobileNavToggle は SSR されるので、ハイドレーション前でもボタンは存在し
  // Playwright の操作可能判定を通ってしまう。その隙にクリックすると onClick が
  // まだ結び付いておらず「押せたのに何も起きない」状態になり、Playwright は
  // 成功したクリックを再試行しないので後続の待機がタイムアウトする
  // (CI の retries: 2 が flake として覆い隠すため、検出網としてはむしろ有害)。
  // aria-expanded は Client Component が描く属性なので、その存在を合図に使う
  async function openDrawer(page: Page) {
    // ハンバーガー (閉じているときのラベル) を指す
    const toggle = page.getByRole('button', { name: 'メニューを開く' });
    // ハイドレーション済みであることを aria-expanded の値で確かめる
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // 開く
    await toggle.click();
  }

  // ドロワー内の「ダッシュボード」リンクをロールで指すロケータ
  const navLinkByRole = (page: Page) =>
    page.locator('#mobile-sidebar').getByRole('link', { name: 'ダッシュボード' });

  // 閉じているドロワーは「画面外へずらしただけ」ではなく、中の要素ごと
  // タブ順・読み上げ順から外れていること (visibility:hidden)。
  // translate だけで隠していた頃は、スキップリンクの次の Tab で「画面のどこにも見えない
  // ナビリンク」に到達し、Enter でそのまま遷移できてしまった
  test('閉じているあいだナビリンクはフォーカスできない', async ({ page }) => {
    // ドロワー内の「ダッシュボード」リンクを DOM 上の属性で指す
    // (ロールでは引けないことを下で確かめるため、ここでは CSS セレクタを使う)
    const navLinkInDom = page.locator('#mobile-sidebar a[href="/dashboard"]');
    // 要素自体は DOM に残っている (条件描画ではなく CSS で隠しているため)
    await expect(navLinkInDom).toBeAttached();
    // ただし可視ではない = キーボードのフォーカス対象にならない
    await expect(navLinkInDom).not.toBeVisible();
    // **ロールでは 1 件も引けない**ことまで確かめる。visibility:hidden の要素は
    // アクセシビリティツリーからも外れるため、スクリーンリーダーの仮想カーソルも到達しない。
    // translate で画面外へずらしていただけの頃は、ここが 1 件ヒットしていた
    await expect(navLinkByRole(page)).toHaveCount(0);
    // ドロワー内の閉じるボタンも同様にロールから消えている (開くまでは押しようがない)
    await expect(
      page.locator('#mobile-sidebar').getByRole('button', { name: 'ナビゲーションを閉じる' }),
    ).toHaveCount(0);
  });

  // 開いた直後にフォーカスがドロワーの中へ移ること (背面に取り残さない §7)。
  // これが無いと、キーボード利用者はメニューを開いても Tab を何度も押して
  // 背面のページを通り抜けないとメニューへ到達できない
  test('開くとフォーカスがドロワー内へ移る', async ({ page }) => {
    // ドロワーを開く
    await openDrawer(page);
    // ナビリンクが可視になる
    await expect(navLinkByRole(page)).toBeVisible();
    // フォーカスされている要素がドロワーの内側にあることを確かめる
    await expect(page.locator('#mobile-sidebar :focus')).toHaveCount(1);
  });

  // Tab がドロワー内で循環すること (フォーカストラップ §7)。
  // 末尾の要素から Tab を押しても背面のコンテンツへ抜けない
  test('Tab はドロワー内で循環し背面へ抜けない', async ({ page }) => {
    // ドロワーを開く
    await openDrawer(page);
    // ナビリンクが可視になるまで待つ
    await expect(navLinkByRole(page)).toBeVisible();
    // ドロワー内のフォーカス可能要素の数だけ Tab を押しても、
    // フォーカスは常にドロワーの内側に留まる (一周して戻ってくる)
    const focusableCount = await page
      .locator('#mobile-sidebar a[href], #mobile-sidebar button')
      .count();
    for (let i = 0; i < focusableCount + 1; i += 1) {
      // 1 回 Tab を押す
      await page.keyboard.press('Tab');
      // 押すたびにフォーカスがドロワー内にあることを確かめる
      await expect(page.locator('#mobile-sidebar :focus')).toHaveCount(1);
    }
  });

  // ハンバーガーで開くとナビリンクが可視になり、ドロワー内の閉じるボタンで閉じられること。
  // 閉じるボタンは aria-modal="true" が Header のハンバーガーを支援技術から隠すための
  // 代替の脱出口なので、押して実際に閉じるところまで確かめる
  test('ドロワー内の閉じるボタンで閉じられる', async ({ page }) => {
    // ドロワーを開く
    await openDrawer(page);
    // ナビリンクが可視になる
    await expect(navLinkByRole(page)).toBeVisible();
    // ドロワー内の閉じるボタン (Header のハンバーガーとは別名にしてある) を押す
    await page
      .locator('#mobile-sidebar')
      .getByRole('button', { name: 'ナビゲーションを閉じる' })
      .click();
    // 閉じるとナビリンクは再び不可視になる
    await expect(navLinkByRole(page)).toHaveCount(0);
  });

  // Esc キーでも閉じられ、フォーカスが開く前の要素 (ハンバーガー) へ戻ること
  // (§7「モーダルはフォーカストラップ + Esc で閉じ」+ フォーカス復元)
  test('Esc キーで閉じ、フォーカスがハンバーガーへ戻る', async ({ page }) => {
    // ドロワーを開く
    await openDrawer(page);
    // ナビリンクが可視になる
    await expect(navLinkByRole(page)).toBeVisible();
    // Esc を押す
    await page.keyboard.press('Escape');
    // 閉じてナビリンクがロールから消える
    await expect(navLinkByRole(page)).toHaveCount(0);
    // フォーカスは開く前の要素 = ハンバーガー (閉じた状態のラベル) へ戻っている
    await expect(page.getByRole('button', { name: 'メニューを開く' })).toBeFocused();
  });
});
