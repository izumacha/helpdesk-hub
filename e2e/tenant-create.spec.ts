// Playwright のテスト DSL と Page 型
import { test, expect, Page } from '@playwright/test';
// E2E 後始末で作成テナント/ユーザーを消すため Prisma Client を使う
import { PrismaClient } from '../src/generated/prisma';

// DB 直接操作用 Prisma Client (後始末専用)
const prisma = new PrismaClient();

// 既存 seed の管理者 (テナントを作成する側)
const ADMIN_EMAIL = 'admin@example.com';
// テスト実行ごとに一意な新管理者メール (リトライ間の衝突を避ける)
const NEW_ADMIN_EMAIL = `e2e-new-admin-${Date.now()}@example.com`;
// 作成する組織名
const NEW_TENANT_NAME = `E2E 新組織 ${Date.now()}`;

// 共通ログイン手順 (パスワードタブが既定)
async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel(/メールアドレス|Email/i).fill(email);
  await page.getByLabel(/パスワード|Password/i).fill('password123');
  await page.getByRole('button', { name: /ログイン/i }).click();
  await page.waitForURL(/\/dashboard|\/tickets/);
}

// テスト後に作成したテナント (連鎖でユーザーも) を掃除する
test.afterAll(async () => {
  // 作成ユーザーを先に消す (念のため)
  await prisma.user.deleteMany({ where: { email: NEW_ADMIN_EMAIL } });
  // 組織名で作成テナントを消す (ON DELETE CASCADE で配下も消える)
  await prisma.tenant.deleteMany({ where: { name: NEW_TENANT_NAME } });
  // Prisma 接続を閉じる
  await prisma.$disconnect();
});

test.describe('テナント作成フロー', () => {
  test('管理者が新しい組織と初代管理者を作成し、新管理者でログインできる', async ({
    page,
    browser,
  }) => {
    // 既存管理者でログインする
    await login(page, ADMIN_EMAIL);

    // テナント作成ページへ移動する
    await page.goto('/settings/tenants/new');
    // 見出しが見えることを確認する
    await expect(page.getByRole('heading', { name: '新しい組織を作成' })).toBeVisible();

    // 組織名・初代管理者の情報を入力する
    await page.getByLabel('組織名').fill(NEW_TENANT_NAME);
    await page.getByLabel(/業種/).fill('製造業');
    await page.getByLabel('お名前').fill('E2E 新管理者');
    await page.getByLabel('メールアドレス').fill(NEW_ADMIN_EMAIL);
    await page.getByLabel(/パスワード/).fill('password123');
    // 作成ボタンを押す
    await page.getByRole('button', { name: '組織を作成する' }).click();

    // 成功メッセージが表示されることを確認する
    await expect(page.getByRole('status')).toContainText('組織を作成しました');

    // 新管理者で別コンテキストからログインできることを確認する
    const newContext = await browser.newContext();
    const newPage = await newContext.newPage();
    await newPage.goto('/login');
    await newPage.getByLabel(/メールアドレス|Email/i).fill(NEW_ADMIN_EMAIL);
    await newPage.getByLabel(/パスワード|Password/i).fill('password123');
    await newPage.getByRole('button', { name: /ログイン/i }).click();
    // 管理者なのでダッシュボードへ遷移する
    await newPage.waitForURL(/\/dashboard/);

    // 新組織は空なので、既存組織のチケット (例: VPN に接続できない) は見えない
    await newPage.goto('/tickets');
    await expect(newPage.getByText('VPN に接続できない')).toHaveCount(0);

    // 後始末
    await newContext.close();
  });
});
