import { test, expect } from '@playwright/test';

test.describe('認証', () => {
  test('ログインページが表示される', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /ログイン|HelpDesk/i })).toBeVisible();
    await expect(page.getByLabel(/メールアドレス|Email/i)).toBeVisible();
    await expect(page.getByLabel(/パスワード|Password/i)).toBeVisible();
  });

  test('未認証でダッシュボードにアクセスするとログインページにリダイレクトされる', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('有効な認証情報でログインできる', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/メールアドレス|Email/i).fill('agent1@example.com');
    await page.getByLabel(/パスワード|Password/i).fill('password123');
    await page.getByRole('button', { name: /ログイン/i }).click();
    await expect(page).toHaveURL(/\/dashboard|\/tickets/);
  });

  test('無効な認証情報でログインが失敗する', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/メールアドレス|Email/i).fill('wrong@example.com');
    await page.getByLabel(/パスワード|Password/i).fill('wrongpassword');
    await page.getByRole('button', { name: /ログイン/i }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});
