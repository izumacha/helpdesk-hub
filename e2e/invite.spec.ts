// Playwright のテスト DSL と Page 型
import { test, expect, Page } from '@playwright/test';
// E2E 後始末で作成ユーザー/招待を消すため Prisma Client を使う
import { PrismaClient } from '../src/generated/prisma';

// DB 直接操作用 Prisma Client (後始末専用)
const prisma = new PrismaClient();

// 既存 seed の管理者 (招待を発行する側)
const ADMIN_EMAIL = 'admin@example.com';
// テスト実行ごとに一意な受諾者メール (リトライ間の衝突を避ける)
const INVITEE_EMAIL = `e2e-invitee-${Date.now()}@example.com`;

// 共通ログイン手順 (パスワードタブが既定)
async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel(/メールアドレス|Email/i).fill(email);
  await page.getByLabel(/パスワード|Password/i).fill('password123');
  await page.getByRole('button', { name: /ログイン/i }).click();
  await page.waitForURL(/\/dashboard|\/tickets/);
}

// テスト後に作成したユーザーを掃除する (招待は ON DELETE/掃除に任せる)
test.afterAll(async () => {
  // 受諾で作られたユーザーを削除する (存在しなくてもエラーにしない)
  await prisma.user.deleteMany({ where: { email: INVITEE_EMAIL } });
  // Prisma 接続を閉じる
  await prisma.$disconnect();
});

test.describe('メンバー招待フロー', () => {
  test('管理者が招待リンクを発行し、受諾するとログインできる', async ({ page, browser }) => {
    // 管理者でログインする
    await login(page, ADMIN_EMAIL);

    // 設定画面へ移動する
    await page.goto('/settings');
    // 招待セクションが見えることを確認する
    await expect(page.getByRole('heading', { name: 'メンバーを招待' })).toBeVisible();

    // 「メンバー」権限を選択する (既定だが明示)
    await page.getByRole('radio', { name: 'メンバー' }).check();
    // 招待リンクを発行する
    await page.getByRole('button', { name: '招待リンクを発行する' }).click();

    // 発行された招待リンクが表示されるまで待つ
    const linkInput = page.getByLabel('発行された招待リンク');
    await expect(linkInput).toBeVisible();
    // 招待 URL を読み取る
    const inviteUrl = await linkInput.inputValue();
    expect(inviteUrl).toContain('/invite/');

    // 受諾は別コンテキスト (未ログインの新規ブラウザ) で行う
    const inviteeContext = await browser.newContext();
    const inviteePage = await inviteeContext.newPage();
    // 招待リンクを開く
    await inviteePage.goto(inviteUrl);
    // 受諾フォームの見出しが見えることを確認する
    await expect(inviteePage.getByRole('heading', { name: /招待/ })).toBeVisible();

    // 氏名・メール・パスワードを入力する (リンクにメール無しなのでメール入力欄が出る)
    await inviteePage.getByLabel('お名前').fill('E2E 招待メンバー');
    await inviteePage.getByLabel('メールアドレス').fill(INVITEE_EMAIL);
    await inviteePage.getByLabel(/パスワード/).fill('password123');
    // 参加ボタンを押す
    await inviteePage.getByRole('button', { name: /参加して利用を開始する/ }).click();

    // メンバー (requester) なので問い合わせ一覧へ遷移する
    await inviteePage.waitForURL(/\/tickets/);
    // アプリのナビ (問い合わせ一覧) が見えることで、ログイン済みであることを確認する
    await expect(inviteePage.getByRole('link', { name: '問い合わせ一覧' })).toBeVisible();

    // 後始末
    await inviteeContext.close();
  });

  test('使用済みの招待リンクは再度受諾できない', async ({ page, browser }) => {
    // 管理者でログインして招待を 1 件発行する
    await login(page, ADMIN_EMAIL);
    await page.goto('/settings');
    await page.getByRole('radio', { name: 'メンバー' }).check();
    await page.getByRole('button', { name: '招待リンクを発行する' }).click();
    const inviteUrl = await page.getByLabel('発行された招待リンク').inputValue();

    // 1 回目の受諾 (一意メールで成功させる)
    const firstEmail = `e2e-invitee-once-${Date.now()}@example.com`;
    const ctx1 = await browser.newContext();
    const p1 = await ctx1.newPage();
    await p1.goto(inviteUrl);
    await p1.getByLabel('お名前').fill('一回目');
    await p1.getByLabel('メールアドレス').fill(firstEmail);
    await p1.getByLabel(/パスワード/).fill('password123');
    await p1.getByRole('button', { name: /参加して利用を開始する/ }).click();
    await p1.waitForURL(/\/tickets/);
    await ctx1.close();

    // 2 回目に同じリンクを開くと「無効/使用済み」の案内が出る。
    // role=alert は Next.js のルートアナウンサーとも一致してしまうため、本文テキストで特定する
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    await p2.goto(inviteUrl);
    await expect(p2.getByText(/この招待リンクは無効/)).toBeVisible();
    await ctx2.close();

    // 後始末 (1 回目で作ったユーザーを消す)
    await prisma.user.deleteMany({ where: { email: firstEmail } });
  });
});
