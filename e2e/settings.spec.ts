// Playwright のテスト DSL と Page 型 (ページ操作の API)
import { test, expect, Page } from '@playwright/test';

// 監査で発見したギャップ: /settings (テナント全体の設定ハブ。動作モード切替・メンバー招待・
// 外部通知連携・拠点管理・課金・SSO・LINE連携などを束ねる管理者専用ページ) は
// invite.spec.ts / tenant-create.spec.ts から admin として間接的に訪問されているだけで、
// /audit ページと同様の admin 限定 RBAC 境界そのものを検証する E2E テストが無かった。
// admin 以外を弾く判定はページ側で isAgent(role) ではなく role === 'admin' を直接比較する
// (§9: UI 非表示だけに頼らずサーバー側で強制する) 設計であることを確認する。

// 共通ログイン手順 (他の e2e spec と同じパターン)
async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel(/メールアドレス|Email/i).fill(email);
  await page.getByLabel(/パスワード|Password/i).fill('password123');
  await page.getByRole('button', { name: /ログイン/i }).click();
  await page.waitForURL(/\/dashboard|\/tickets/);
}

test.describe('/settings 設定ページ', () => {
  // 管理者 (admin@example.com) は設定ハブの主要セクションを閲覧できる
  test('管理者は設定ページの主要セクションを閲覧できる', async ({ page }) => {
    await login(page, 'admin@example.com');
    await page.goto('/settings');

    await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible();
    // 動作モード (Lite/Pro 切替) セクション
    await expect(page.getByRole('heading', { name: '動作モード' })).toBeVisible();
    // メンバー招待セクション
    await expect(page.getByRole('heading', { name: 'メンバーを招待' })).toBeVisible();
    // 拠点・店舗管理セクション (Phase 4 多拠点)
    await expect(page.getByRole('heading', { name: '拠点・店舗管理' })).toBeVisible();
  });

  // 依頼者 (requester) は管理者専用メッセージのみ表示され、設定セクションは見えない
  test('依頼者は設定ページを閲覧できず管理者専用メッセージが表示される', async ({ page }) => {
    await login(page, 'requester1@example.com');
    await page.goto('/settings');

    await expect(page.getByText('この画面は管理者のみ利用できます。')).toBeVisible();
    await expect(page.getByRole('heading', { name: '動作モード' })).toHaveCount(0);
  });

  // エージェント (agent) も admin 専用であり、isAgent(role) ではなく role==='admin' の
  // 直接比較を採用している設計を検証する
  test('エージェントも管理者専用メッセージが表示され閲覧できない', async ({ page }) => {
    await login(page, 'agent1@example.com');
    await page.goto('/settings');

    await expect(page.getByText('この画面は管理者のみ利用できます。')).toBeVisible();
    await expect(page.getByRole('heading', { name: '動作モード' })).toHaveCount(0);
  });

  // middleware は /settings を認証必須ページとして扱う (未認証は /login へリダイレクト)
  test('未認証で /settings にアクセスするとログインページへリダイレクトされる', async ({
    page,
  }) => {
    await page.goto('/settings');
    await page.waitForURL(/\/login/);
  });
});
