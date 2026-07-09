// Playwright のテスト DSL と Page 型 (ページ操作の API)
import { test, expect, Page } from '@playwright/test';
// E2E 後始末で作成したテナントを消すため Prisma Client を使う
import { PrismaClient } from '../src/generated/prisma';

// 監査で発見したギャップ: 拠点管理 (Phase 4 多拠点 §5.2) は Server Action レベルの
// テスト (tests/features/{create,update,delete}-location.test.ts) はあるが、実際に
// ブラウザ経由で「/settings で拠点を作成 → ダッシュボードの拠点フィルタピルに現れる →
// 選択できる → /settings で削除するとピルが消える」という DB を跨ぐ一連の流れを
// 検証する E2E テストが無かった。
//
// 拠点フィルタピルは Pro モードの従来ダッシュボードにしか出ない (Lite モードは
// 2 タイルの簡易版に置換される) が、既定 seed テナントは mode: 'lite' で他の多数の
// spec (lite-mode.spec.ts 等) がこの共有テナントの Lite 挙動に依存しているため、
// 共有テナントのモードをここで 'pro' に切り替えると並列実行中の他 spec を壊す。
// そのため tenant-create.spec.ts と同じパターンで、このテスト専用の新規テナント +
// 管理者を作成し、そのテナントだけを Pro モードに切り替えて安全に検証する。

const ADMIN_EMAIL = 'admin@example.com';
const NEW_ADMIN_EMAIL = `e2e-location-admin-${Date.now()}@example.com`;
const NEW_TENANT_NAME = `E2E拠点テスト組織-${Date.now()}`;
const LOCATION_NAME = 'E2Eテスト拠点';

// DB 直接操作用 Prisma Client (後始末専用)
const prisma = new PrismaClient();

// 共通ログイン手順 (他の e2e spec と同じパターン)
async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel(/メールアドレス|Email/i).fill(email);
  await page.getByLabel(/パスワード|Password/i).fill('password123');
  await page.getByRole('button', { name: /ログイン/i }).click();
  await page.waitForURL(/\/dashboard|\/tickets/);
}

// テスト後に作成したテナントを掃除する (tenant-create.spec.ts と同じ後始末パターン)
test.afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { name: NEW_TENANT_NAME } });
  await prisma.user.deleteMany({ where: { email: NEW_ADMIN_EMAIL } });
  await prisma.$disconnect();
});

test.describe('拠点管理 (作成 → ダッシュボードのフィルタピル → 削除)', () => {
  test('管理者が拠点を作成するとダッシュボードのフィルタピルに現れ、削除すると消える', async ({
    page,
    browser,
  }) => {
    // このテスト専用の新規テナント + 初代管理者を作成する (共有テナントを汚染しない)
    await login(page, ADMIN_EMAIL);
    await page.goto('/settings/tenants/new');
    await page.getByLabel('組織名').fill(NEW_TENANT_NAME);
    await page.getByLabel(/業種/).selectOption({ label: '製造業' });
    await page.getByLabel('お名前').fill('E2E拠点テスト管理者');
    await page.getByLabel('メールアドレス').fill(NEW_ADMIN_EMAIL);
    await page.getByLabel(/パスワード/).fill('password123');
    await page.getByRole('button', { name: '組織を作成する' }).click();
    await expect(page.getByRole('status')).toContainText('組織を作成しました');

    // 新規テナントは既定で Free プラン (トライアル中は実効 Standard 相当) のため、
    // Pro モードへの切替が「Pro/Enterprise プランでご利用いただけます」という警告で
    // ブロックされる。Stripe 決済を経由せず直接 DB でプランを pro に引き上げる
    // (tenant-create.spec.ts が trialEndsAt を直接更新するのと同じ後始末専用 Prisma 操作)
    await prisma.tenant.updateMany({
      where: { name: NEW_TENANT_NAME },
      data: { subscriptionPlan: 'pro' },
    });

    // 新管理者で別コンテキストからログインする (このテナント専用の操作はこちらで行う)
    const context = await browser.newContext();
    const newPage = await context.newPage();
    await login(newPage, NEW_ADMIN_EMAIL);

    // 新規テナントは既定で Lite モードのため、拠点フィルタピルが出る Pro モードへ切り替える
    // (この新規テナントは他 spec と共有されないため、モード変更しても他テストに影響しない)
    await newPage.goto('/settings');
    // 「保存する」ボタンは他フォーム (通知チャネル設定等) にも存在するため、動作モードの
    // フォームに絞り込んでから操作する
    const modeForm = newPage.locator('form', { has: newPage.getByText('動作モードを選択') });
    await modeForm.getByRole('radio', { name: /詳細モード/ }).click();
    await modeForm.getByRole('button', { name: '保存する' }).click();
    await expect(newPage.getByText('モードを保存しました。')).toBeVisible();

    // 拠点追加フォームを開く
    await newPage.reload();
    await newPage.getByRole('button', { name: '＋ 拠点を追加' }).click();
    await newPage.getByLabel('拠点名').fill(LOCATION_NAME);
    await newPage.getByRole('button', { name: '追加する' }).click();

    // 作成成功後は window.location.reload() で再読み込みされるため、一覧に反映されるまで待つ
    await expect(newPage.getByText(LOCATION_NAME)).toBeVisible();

    // ダッシュボードへ移動し、拠点フィルタピルとして表示されることを確認する
    await newPage.goto('/dashboard');
    const pill = newPage.getByRole('link', { name: new RegExp(LOCATION_NAME) });
    await expect(pill).toBeVisible();

    // ピルをクリックすると選択状態になり、URL に locationId が反映される
    await pill.click();
    await expect(newPage).toHaveURL(/locationId=/);
    await expect(newPage.getByRole('link', { name: new RegExp(LOCATION_NAME) })).toHaveAttribute(
      'aria-current',
      'true',
    );

    // /settings に戻って削除する (削除は window.confirm を伴うため自動承諾する)
    await newPage.goto('/settings');
    newPage.once('dialog', (dialog) => dialog.accept());
    const locationItem = newPage.getByText(LOCATION_NAME).locator('..').locator('..');
    await locationItem.getByRole('button', { name: '削除' }).click();

    // 一覧から消えることを確認する
    await expect(newPage.getByText(LOCATION_NAME)).toHaveCount(0);

    // ダッシュボードのフィルタピルからも消えることを確認する
    await newPage.goto('/dashboard');
    await expect(newPage.getByRole('link', { name: new RegExp(LOCATION_NAME) })).toHaveCount(0);

    await context.close();
  });
});
