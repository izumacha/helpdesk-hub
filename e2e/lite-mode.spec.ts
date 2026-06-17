// Playwright のテスト DSL と Page 型
import { test, expect, Page } from '@playwright/test';

// 共通ログイン関数 (デフォルトはエージェント、引数で別ユーザーへ切替可)
// seed の default-tenant は mode='lite' のため、ここでログインする全ユーザーは Lite テナントに属する
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

// Lite モード (seed 既定) の画面挙動を検証する
test.describe('Lite モード', () => {
  // ダッシュボードは Lite の 3 ステータスだけを表示し、Pro 専用の指標を出さない
  test('ダッシュボードは3ステータスのみ表示し SLA を出さない', async ({ page }) => {
    // エージェントでログイン (Pro 専用要素が role ではなく mode で隠れることを確かめるため)
    await login(page);
    // ダッシュボードへ遷移
    await page.goto('/dashboard');
    // 見出しが表示される
    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
    // Lite の 3 ラベル (未対応/対応中/完了) が表示される
    await expect(page.getByText('未対応').first()).toBeVisible();
    await expect(page.getByText('対応中').first()).toBeVisible();
    await expect(page.getByText('完了').first()).toBeVisible();
    // Pro 用語 (新規/エスカレーション) のカードは存在しない
    await expect(page.getByText('新規', { exact: true })).toHaveCount(0);
    await expect(page.getByText('エスカレーション', { exact: true })).toHaveCount(0);
    // SLA 超過セクションは Lite では非表示
    await expect(page.getByText('SLA 超過')).toHaveCount(0);
  });

  // サイドバーに FAQ候補メニューが出ない (Lite では proOnly のため隠れる)
  test('サイドバーに FAQ候補 が表示されない', async ({ page }) => {
    // エージェントでログイン
    await login(page);
    // FAQ候補へのリンクが 1 つも無いこと
    await expect(page.getByRole('link', { name: 'FAQ候補' })).toHaveCount(0);
  });

  // 新規登録フォームは件名/内容/期限のみで、カテゴリ・優先度を出さない
  test('新規登録フォームはカテゴリ・優先度を出さず期限日を出す', async ({ page }) => {
    // 依頼者でログイン
    await login(page, 'requester1@example.com');
    // 新規登録ページへ遷移
    await page.goto('/tickets/new');
    // 期限日 (いつまでに) は Lite で表示される
    await expect(page.getByText('いつまでに')).toBeVisible();
    // カテゴリ・優先度は Lite では非表示
    await expect(page.getByText('カテゴリ', { exact: true })).toHaveCount(0);
    await expect(page.getByText('優先度', { exact: true })).toHaveCount(0);
  });

  // Lite で起票したチケットは「未対応」(Open) で始まる
  test('起票直後のチケットは未対応で始まる', async ({ page }) => {
    // 依頼者でログイン
    await login(page, 'requester1@example.com');
    // 新規登録ページへ遷移
    await page.goto('/tickets/new');
    // 件名を入力
    await page.getByPlaceholder(/件名を入力/).fill('Liteモード起票テスト');
    // 本文を入力
    await page.getByPlaceholder(/問い合わせ内容/).fill('Liteモードで起票したチケットのステータス確認');
    // 「登録する」ボタンを押下
    await page.getByRole('button', { name: '登録する' }).click();
    // 詳細ページへ遷移する
    await expect(page).toHaveURL(/\/tickets\//);
    // 詳細に「未対応」ステータスが表示される (New=新規 ではない)
    await expect(page.getByText('未対応').first()).toBeVisible();
    // 新規 ラベルは出ない
    await expect(page.getByText('新規', { exact: true })).toHaveCount(0);
  });
});
