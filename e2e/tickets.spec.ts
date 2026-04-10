import { test, expect, Page } from '@playwright/test';

async function login(page: Page, email = 'agent1@example.com') {
  await page.goto('/login');
  await page.getByLabel(/メールアドレス|Email/i).fill(email);
  await page.getByLabel(/パスワード|Password/i).fill('password123');
  await page.getByRole('button', { name: /ログイン/i }).click();
  await page.waitForURL(/\/dashboard|\/tickets/);
}

test.describe('チケット一覧', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/tickets');
  });

  test('一覧ページが表示される', async ({ page }) => {
    await expect(page.getByRole('heading', { name: '問い合わせ一覧' })).toBeVisible();
    await expect(page.getByRole('link', { name: '新規登録' })).toBeVisible();
  });

  test('フィルタUIが表示される', async ({ page }) => {
    await expect(page.getByPlaceholder(/キーワード検索/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'リセット' })).toBeVisible();
  });
});

test.describe('チケット登録', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'requester1@example.com');
  });

  test('新規チケットを登録できる', async ({ page }) => {
    await page.goto('/tickets/new');
    await expect(page.getByRole('heading', { name: /新規登録|問い合わせ/ })).toBeVisible();

    await page.getByPlaceholder(/件名を入力/).fill('E2Eテスト用チケット');
    await page.getByPlaceholder(/問い合わせ内容/).fill('これはPlaywrightによるE2Eテストです。');
    await page.getByRole('button', { name: '登録する' }).click();

    // 詳細ページにリダイレクトされる
    await expect(page).toHaveURL(/\/tickets\//);
    await expect(page.getByText('E2Eテスト用チケット')).toBeVisible();
  });
});

test.describe('チケット詳細', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/tickets');
  });

  test('チケットをクリックして詳細が表示される', async ({ page }) => {
    const firstLink = page.getByRole('table').getByRole('link').first();
    await firstLink.click();
    await expect(page).toHaveURL(/\/tickets\//);
    await expect(page.getByText('問い合わせ内容')).toBeVisible();
    await expect(page.getByText('変更履歴')).toBeVisible();
  });
});
