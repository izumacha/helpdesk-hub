// Playwright のテスト DSL と Page 型
import { test, expect, Page } from '@playwright/test';

// 共通ログイン関数 (デフォルトはエージェント、引数で別ユーザーへ切替可)
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

// チケット一覧ページの基本表示確認
test.describe('チケット一覧', () => {
  // 各テストの前にエージェントでログインし、一覧ページを開いておく
  test.beforeEach(async ({ page }) => {
    await login(page);
    // チケット一覧へ遷移
    await page.goto('/tickets');
  });

  // 見出しと「新規登録」リンクが表示される
  test('一覧ページが表示される', async ({ page }) => {
    // 見出しが「問い合わせ一覧」であること
    await expect(page.getByRole('heading', { name: '問い合わせ一覧' })).toBeVisible();
    // 新規登録リンクが表示されること
    await expect(page.getByRole('link', { name: '新規登録' })).toBeVisible();
  });

  // フィルタ用の検索ボックスとリセットボタンが表示される
  test('フィルタUIが表示される', async ({ page }) => {
    // キーワード検索入力欄
    await expect(page.getByPlaceholder(/キーワード検索/)).toBeVisible();
    // リセットボタン
    await expect(page.getByRole('button', { name: 'リセット' })).toBeVisible();
  });
});

// 依頼者ロールによる新規チケット登録フロー
test.describe('チケット登録', () => {
  // 各テストの前に依頼者でログイン
  test.beforeEach(async ({ page }) => {
    await login(page, 'requester1@example.com');
  });

  // 新規登録フォームから送信して詳細ページに遷移すること
  test('新規チケットを登録できる', async ({ page }) => {
    // 新規登録ページへ遷移
    await page.goto('/tickets/new');
    // フォームの見出しが表示される
    await expect(page.getByRole('heading', { name: /新規登録|問い合わせ/ })).toBeVisible();

    // 件名を入力
    await page.getByPlaceholder(/件名を入力/).fill('E2Eテスト用チケット');
    // 本文を入力
    await page.getByPlaceholder(/問い合わせ内容/).fill('これはPlaywrightによるE2Eテストです。');
    // 「登録する」ボタンを押下
    await page.getByRole('button', { name: '登録する' }).click();

    // 詳細ページにリダイレクトされる
    // URL が /tickets/<id> 形式に変わっていること
    await expect(page).toHaveURL(/\/tickets\//);
    // 入力した件名が詳細ページに表示されていること
    await expect(page.getByText('E2Eテスト用チケット')).toBeVisible();
  });
});

// チケット詳細ページへの遷移確認
test.describe('チケット詳細', () => {
  // 各テストの前にエージェントでログインし、一覧ページを開く
  test.beforeEach(async ({ page }) => {
    await login(page);
    // 一覧ページへ遷移
    await page.goto('/tickets');
  });

  // 一覧の最初の行をクリックして詳細が見えること
  test('チケットをクリックして詳細が表示される', async ({ page }) => {
    // 一覧テーブル内の最初のリンクを取得
    const firstLink = page.getByRole('table').getByRole('link').first();
    // クリックして詳細ページへ
    await firstLink.click();
    // URL が /tickets/<id> に変わっていること
    await expect(page).toHaveURL(/\/tickets\//);
    // 本文セクションが表示される
    await expect(page.getByText('問い合わせ内容')).toBeVisible();
    // 履歴セクションも表示される
    await expect(page.getByText('変更履歴')).toBeVisible();
  });
});
