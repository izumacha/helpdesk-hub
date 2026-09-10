// Playwright のテスト DSL と Page 型
import { test, expect, Page } from '@playwright/test';

// 共通ログイン関数 (他のスペックと同じ手順。seed 済みのエージェントでログインする)
async function login(page: Page, email = 'agent1@example.com') {
  // ログインページへ遷移
  await page.goto('/login');
  // メールアドレスを入力
  await page.getByLabel(/メールアドレス|Email/i).fill(email);
  // 共通パスワードを入力
  await page.getByLabel(/パスワード|Password/i).fill('password123');
  // ログインボタンを押下
  await page.getByRole('button', { name: /ログイン/i }).click();
  // ロール別の遷移先 (/dashboard か /tickets) まで待機
  await page.waitForURL(/\/dashboard|\/tickets/);
}

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

  // 閉じているドロワーは「画面外へずらしただけ」ではなく、中の要素ごと
  // タブ順・読み上げ順から外れていること (visibility:hidden)。
  // translate だけで隠していた頃は、スキップリンクの次の Tab で「画面のどこにも見えない
  // ナビリンク」に到達し、Enter でそのまま遷移できてしまった
  test('閉じているあいだナビリンクはフォーカスできない', async ({ page }) => {
    // エージェントでログインする
    await login(page);
    // チケット一覧を開く (ドロワーは閉じた状態が既定)
    await page.goto('/tickets');
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
    await expect(
      page.locator('#mobile-sidebar').getByRole('link', { name: 'ダッシュボード' }),
    ).toHaveCount(0);
    // ドロワー内の閉じるボタンも同様にロールから消えている (開くまでは押しようがない)
    await expect(
      page.locator('#mobile-sidebar').getByRole('button', { name: 'ナビゲーションを閉じる' }),
    ).toHaveCount(0);
  });

  // ハンバーガーで開くとナビリンクが可視になり、ドロワー内の閉じるボタンで閉じられること。
  // 閉じるボタンは aria-modal="true" が Header のハンバーガーを支援技術から隠すための
  // 代替の脱出口なので、押して実際に閉じるところまで確かめる
  test('ハンバーガーで開き、ドロワー内の閉じるボタンで閉じられる', async ({ page }) => {
    // エージェントでログインする
    await login(page);
    // チケット一覧を開く
    await page.goto('/tickets');
    // Header のハンバーガー (開状態では「メニューを閉じる」に変わるので開くとき限定の名前で指す)
    await page.getByRole('button', { name: 'メニューを開く' }).click();
    // サイドバー内の「ダッシュボード」リンクが可視になる
    const navLink = page.locator('#mobile-sidebar').getByRole('link', { name: 'ダッシュボード' });
    await expect(navLink).toBeVisible();
    // ドロワー内の閉じるボタン (Header のハンバーガーとは別名にしてある) を押す
    await page
      .locator('#mobile-sidebar')
      .getByRole('button', { name: 'ナビゲーションを閉じる' })
      .click();
    // 閉じるとナビリンクは再び不可視になる
    await expect(navLink).not.toBeVisible();
  });

  // Esc キーでも閉じられること (§7「モーダルはフォーカストラップ + Esc で閉じ」)
  test('Esc キーで閉じられる', async ({ page }) => {
    // エージェントでログインする
    await login(page);
    // チケット一覧を開く
    await page.goto('/tickets');
    // ハンバーガーで開く
    await page.getByRole('button', { name: 'メニューを開く' }).click();
    // サイドバー内の「ダッシュボード」リンクが可視になる
    const navLink = page.locator('#mobile-sidebar').getByRole('link', { name: 'ダッシュボード' });
    await expect(navLink).toBeVisible();
    // Esc を押す
    await page.keyboard.press('Escape');
    // 閉じてナビリンクが不可視になる
    await expect(navLink).not.toBeVisible();
  });
});
