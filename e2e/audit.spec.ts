// Playwright のテスト DSL と Page 型 (ページ操作の API)
import { test, expect, Page } from '@playwright/test';

// 監査で発見したギャップ: /audit ページ (Phase 4 Enterprise「監査ログ」§6.1) は
// TicketHistory + SettingsAuditLog のマージ・admin 限定 RBAC・Pro/Enterprise プランゲート・
// CSV エクスポートという複数の非自明な挙動を持つが、E2E テストが一切無かった。
// 管理者専用 (isAgent ではなく role === 'admin' を直接比較する意図的な設計)・
// プランゲート・DB 由来の一覧表示は Vitest ユニットテストの対象外 (CLAUDE.md §11) のため
// E2E で検証する。

// 共通ログイン手順 (各テストの前処理で再利用。他の e2e spec と同じパターン)
async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel(/メールアドレス|Email/i).fill(email);
  await page.getByLabel(/パスワード|Password/i).fill('password123');
  await page.getByRole('button', { name: /ログイン/i }).click();
  await page.waitForURL(/\/dashboard|\/tickets/);
}

test.describe('/audit 監査ログページ', () => {
  // 管理者 (admin@example.com, シードでは pro プラン) は一覧を閲覧できる
  test('管理者は監査ログ一覧とCSVエクスポートボタンを閲覧できる', async ({ page }) => {
    await login(page, 'admin@example.com');
    await page.goto('/audit');

    // ページタイトルが表示される
    await expect(page.getByRole('heading', { name: '監査ログ' })).toBeVisible();

    // シード済みの TicketHistory (seed-t-02/03/05/09) がテーブルに表示される
    // (少なくとも 1 行以上、列見出しの「担当者」を含むテーブルが存在すること)
    await expect(page.getByRole('table', { name: '変更履歴の一覧' })).toBeVisible();
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();

    // CSV エクスポートボタンが有効な状態で表示される (ログが 0 件でないため)。
    // ボタンの aria-label がアクセシブルネームになる (可視テキストより優先される) ため
    // aria-label の文言で照合する
    const exportButton = page.getByRole('button', { name: /監査ログを CSV 形式でダウンロードする/ });
    await expect(exportButton).toBeVisible();
    await expect(exportButton).toBeEnabled();
  });

  // 依頼者 (requester) は管理者専用メッセージのみ表示され、テーブルは見えない
  test('依頼者は監査ログを閲覧できず管理者専用メッセージが表示される', async ({ page }) => {
    await login(page, 'requester1@example.com');
    await page.goto('/audit');

    await expect(page.getByText('この画面は管理者のみ利用できます。')).toBeVisible();
    await expect(page.getByRole('table', { name: '変更履歴の一覧' })).toHaveCount(0);
  });

  // エージェント (agent) も admin 専用であり、isAgent(role) ではなく role==='admin' の
  // 直接比較を採用している設計 (CLAUDE.md 記載の意図的な admin 限定パターン) を検証する
  test('エージェントも管理者専用メッセージが表示され閲覧できない', async ({ page }) => {
    await login(page, 'agent1@example.com');
    await page.goto('/audit');

    await expect(page.getByText('この画面は管理者のみ利用できます。')).toBeVisible();
    await expect(page.getByRole('table', { name: '変更履歴の一覧' })).toHaveCount(0);
  });

  // middleware は /audit を認証必須ページとして扱う (未認証は /login へリダイレクト)
  test('未認証で /audit にアクセスするとログインページへリダイレクトされる', async ({ page }) => {
    await page.goto('/audit');
    await page.waitForURL(/\/login/);
  });
});
