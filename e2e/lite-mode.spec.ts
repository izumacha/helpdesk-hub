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
  // Lite のダッシュボードは「自分の未対応 / 期限切れ」の 2 タイル簡易版 (Pivot plan §3.1) を表示し、
  // Pro 専用の指標 (SLA 超過・担当者別ワークロード) や Pro 用語を出さない
  test('ダッシュボードは Lite 簡易版 (2タイル) を表示し SLA を出さない', async ({ page }) => {
    // エージェントでログイン (Pro 専用要素が role ではなく mode で隠れることを確かめるため)
    await login(page);
    // ダッシュボードへ遷移
    await page.goto('/dashboard');
    // Lite では見出しが「ホーム」(カタカナ/英語を避けたやさしい用語) になる
    await expect(page.getByRole('heading', { name: 'ホーム' })).toBeVisible();
    // 2 枚タイルのラベル (自分の未対応 / 期限切れ) が表示される
    await expect(page.getByText('自分の未対応')).toBeVisible();
    await expect(page.getByText('期限切れ')).toBeVisible();
    // Pro 用語 (新規/エスカレーション) のカードは存在しない
    await expect(page.getByText('新規', { exact: true })).toHaveCount(0);
    await expect(page.getByText('エスカレーション', { exact: true })).toHaveCount(0);
    // SLA 超過セクションは Lite では非表示
    await expect(page.getByText('SLA 超過')).toHaveCount(0);
    // 担当者別ワークロードも Lite では非表示
    await expect(page.getByText('担当者別 未完了件数')).toHaveCount(0);
  });

  // サイドバーの FAQ 候補メニューは Lite でも表示されるが、呼称が「よくある質問」に変わる
  // (§1.1 フォローアップ: 以前は proOnly で隠していたが、Lite テナントでも使える機能のため
  //  呼称だけ切り替えて表示するよう修正した)
  test('サイドバーに よくある質問 が表示され、Pro 用語の FAQ候補 は出ない', async ({ page }) => {
    // エージェントでログイン
    await login(page);
    // Lite 用語の「よくある質問」リンクが表示される
    await expect(page.getByRole('link', { name: 'よくある質問' })).toBeVisible();
    // Pro 用語の「FAQ候補」リンクは存在しない
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
