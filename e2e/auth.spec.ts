// Playwright のテスト DSL (test = it, expect = アサーション)
import { test, expect } from '@playwright/test';

// 認証関連のシナリオをまとめるグループ
test.describe('認証', () => {
  // 未ログイン状態でログインページに各フォーム要素が表示されること
  test('ログインページが表示される', async ({ page }) => {
    // ログインページへ遷移
    await page.goto('/login');
    // 見出しが「ログイン」または「HelpDesk」を含む (大文字小文字無視)
    await expect(page.getByRole('heading', { name: /ログイン|HelpDesk/i })).toBeVisible();
    // メールアドレス入力欄が表示される
    await expect(page.getByLabel(/メールアドレス|Email/i)).toBeVisible();
    // パスワード入力欄が表示される
    await expect(page.getByLabel(/パスワード|Password/i)).toBeVisible();
  });

  // 未ログインで保護ページへ行くと middleware がログインへ飛ばす
  test('未認証でダッシュボードにアクセスするとログインページにリダイレクトされる', async ({ page }) => {
    // 認証必須のダッシュボードへ直接アクセス
    await page.goto('/dashboard');
    // URL が /login を含むこと (リダイレクトされた)
    await expect(page).toHaveURL(/\/login/);
  });

  // 正しいメール/パスワードでログインに成功し、保護ページへ遷移する
  test('有効な認証情報でログインできる', async ({ page }) => {
    // ログインページへ遷移
    await page.goto('/login');
    // シードユーザーのメールアドレスを入力
    await page.getByLabel(/メールアドレス|Email/i).fill('agent1@example.com');
    // 共通パスワードを入力
    await page.getByLabel(/パスワード|Password/i).fill('password123');
    // ログインボタンを押す
    await page.getByRole('button', { name: /ログイン/i }).click();
    // ダッシュボードまたはチケット一覧にリダイレクトされる (役割で分岐)
    await expect(page).toHaveURL(/\/dashboard|\/tickets/);
  });

  // 認証情報が誤っている場合は /login のままに留まる
  test('無効な認証情報でログインが失敗する', async ({ page }) => {
    // ログインページへ遷移
    await page.goto('/login');
    // 存在しないメールアドレスを入力
    await page.getByLabel(/メールアドレス|Email/i).fill('wrong@example.com');
    // 誤ったパスワードを入力
    await page.getByLabel(/パスワード|Password/i).fill('wrongpassword');
    // ログインボタンを押す
    await page.getByRole('button', { name: /ログイン/i }).click();
    // 失敗時は /login にとどまる
    await expect(page).toHaveURL(/\/login/);
  });
});
