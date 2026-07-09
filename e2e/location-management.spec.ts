// Playwright のテスト DSL と Page 型 (ページ操作の API)
import { test, expect, Page } from '@playwright/test';
// E2E 用に DB へ直接 fixture を投入するため Prisma Client を使う (multitenant.spec.ts と同じ方針)
import { PrismaClient, Role } from '../src/generated/prisma';
// ログイン可能なテストユーザーを作るためパスワードをハッシュ化する
import { hash } from 'bcryptjs';

// 監査で発見したギャップ: 拠点管理 (Phase 4 多拠点 §5.2) は Server Action レベルの
// テスト (tests/features/{create,update,delete}-location.test.ts) はあるが、実際に
// ブラウザ経由で「/settings で拠点を作成 → ダッシュボードの拠点フィルタピルに現れる →
// 選択できる → /settings で削除するとピルが消える」という DB を跨ぐ一連の流れを
// 検証する E2E テストが無かった。
//
// /code-review ultra 指摘対応: 当初は /settings/tenants/new の組織作成 UI +
// 動作モード切替 UI を経由して Pro モードのテナントを用意していたが、拠点管理という
// 本題と無関係な 2 つの UI フロー (どちらも他 spec / 単体テストで既にカバー済み) に
// 依存する分だけテストが壊れやすく低速だった。multitenant.spec.ts の
// seedTenantBFixture と同じ「UI を介さず fixture を直接 DB へ投入する」パターンに
// 揃え、最初から Pro モード + Pro プランのテナントを用意することで、この spec の
// 責務を拠点管理の検証だけに絞る。

// このテスト専用の固定 ID 群 (Date.now() 由来の値と違い、CI のリトライで衝突しない。
// upsert で冪等に投入するため何度実行しても同じ行を再利用できる)
const TENANT_ID = 'e2e-location-tenant';
const ADMIN_EMAIL = 'e2e-location-admin@example.com';
const ADMIN_ID = 'e2e-location-admin';
const LOCATION_NAME = 'E2Eテスト拠点';
// 削除対象ではない「無関係な別拠点」の固定 ID。これが無いと拠点が 1 件しか存在しない状態で
// 削除するため、「対象 1 件だけを削除する」ことと「テナントの全拠点を削除する」ことが
// 区別できないテストになってしまう (/code-review ultra 指摘対応)。この拠点は削除操作の
// 対象にせず、削除後も残っていることを確認する対照群として使う
// 名前は正規表現の特殊文字 (括弧等) を含まないようにする (new RegExp() でそのまま使うため)
const OTHER_LOCATION_ID = 'e2e-location-other';
const OTHER_LOCATION_NAME = 'E2Eテスト別拠点維持用';

// DB 直接投入用 Prisma Client
const prisma = new PrismaClient();

// 共通ログイン手順 (他の e2e spec と同じパターン)
async function login(page: Page, email: string) {
  // ログインページへ遷移する
  await page.goto('/login');
  // メールアドレスを入力する
  await page.getByLabel(/メールアドレス|Email/i).fill(email);
  // 共通パスワードを入力する
  await page.getByLabel(/パスワード|Password/i).fill('password123');
  // ログインボタンを押下する
  await page.getByRole('button', { name: /ログイン/i }).click();
  // ロールに応じたリダイレクト先まで待機する
  await page.waitForURL(/\/dashboard|\/tickets/);
}

// このテスト専用の Pro モード + Pro プランのテナントと管理者を直接 DB へ投入する。
// Pro モードへの昇格には Pro/Enterprise プランが必須 (isProModeAllowed) なため、
// Stripe 決済を経由しないテスト専用の近道として最初から subscriptionPlan: 'pro' で作る
// (tenant-create.spec.ts が trialEndsAt を直接更新するのと同種の、テストのみで許される shortcut)
async function seedLocationTenantFixture(): Promise<void> {
  // 共通パスワードのハッシュを 1 回だけ計算する
  const passwordHash = await hash('password123', 12);
  // テナントを冪等に作成/更新する (既に存在すれば mode/plan だけ揃え直す)
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: { mode: 'pro', subscriptionPlan: 'pro' },
    create: { id: TENANT_ID, name: 'E2E拠点テスト組織', mode: 'pro', subscriptionPlan: 'pro' },
  });
  // 管理者ユーザーを冪等に作成/更新する
  await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { passwordHash, role: Role.admin, tenantId: TENANT_ID },
    create: {
      id: ADMIN_ID,
      email: ADMIN_EMAIL,
      name: 'E2E拠点テスト管理者',
      passwordHash,
      role: Role.admin,
      tenantId: TENANT_ID,
    },
  });
  // 削除対象にしない対照群の拠点を冪等に投入する (ID 指定の削除が対象拠点だけに
  // 効いていることを検証するため、テスト全体を通して常に存在させておく)
  await prisma.location.upsert({
    where: { id: OTHER_LOCATION_ID },
    update: { name: OTHER_LOCATION_NAME, tenantId: TENANT_ID },
    create: { id: OTHER_LOCATION_ID, name: OTHER_LOCATION_NAME, tenantId: TENANT_ID },
  });
}

// テスト後の後始末: テナント/管理者自体は multitenant.spec.ts の fixture と同じく
// 永続 fixture として残し削除しない (次回実行時に upsert で再利用するため)。
// 拠点だけは Location.name に一意制約が無く重複作成され得るため、万一テストが
// 拠点削除の前に失敗しても次回実行に影響しないよう明示的に掃除しておく
test.afterAll(async () => {
  // このテナント内の同名拠点を掃除する (通常はテスト本体の削除操作で既に消えている)
  await prisma.location.deleteMany({ where: { tenantId: TENANT_ID, name: LOCATION_NAME } });
  // Prisma 接続を閉じる
  await prisma.$disconnect();
});

test.describe('拠点管理 (作成 → ダッシュボードのフィルタピル → 削除)', () => {
  test('管理者が拠点を作成するとダッシュボードのフィルタピルに現れ、削除すると消える', async ({
    page,
  }) => {
    // このテスト専用の Pro モードテナント + 管理者を用意する
    await seedLocationTenantFixture();
    // 管理者としてログインする
    await login(page, ADMIN_EMAIL);

    // 設定画面へ移動する
    await page.goto('/settings');
    // 拠点追加フォームを開く
    await page.getByRole('button', { name: '＋ 拠点を追加' }).click();
    // 拠点名を入力する
    await page.getByLabel('拠点名').fill(LOCATION_NAME);
    // 追加ボタンを押下する
    await page.getByRole('button', { name: '追加する' }).click();
    // 作成成功後は window.location.reload() で再読み込みされるため、一覧に反映されるまで待つ
    await expect(page.getByText(LOCATION_NAME)).toBeVisible();

    // ダッシュボードへ移動する
    await page.goto('/dashboard');
    // 拠点フィルタピルとして表示されることを確認する
    const pill = page.getByRole('link', { name: new RegExp(LOCATION_NAME) });
    await expect(pill).toBeVisible();

    // ピルをクリックする
    await pill.click();
    // URL に locationId が反映されることを確認する
    await expect(page).toHaveURL(/locationId=/);
    // 選択状態が aria-current="true" で伝わることを確認する (色だけに依存しない a11y)
    await expect(page.getByRole('link', { name: new RegExp(LOCATION_NAME) })).toHaveAttribute(
      'aria-current',
      'true',
    );

    // 設定画面に戻る
    await page.goto('/settings');
    // 削除は window.confirm を伴うため自動承諾するハンドラを仕込む
    page.once('dialog', (dialog) => dialog.accept());
    // 拠点名を含む <li> 要素 (リストの内部マークアップ変更に強い、セマンティックな絞り込み)
    const locationItem = page.getByRole('listitem').filter({ hasText: LOCATION_NAME });
    // 削除ボタンを押下する
    await locationItem.getByRole('button', { name: '削除' }).click();
    // 削除対象の拠点だけが一覧から消えることを確認する
    await expect(page.getByText(LOCATION_NAME)).toHaveCount(0);
    // 対照群の別拠点は削除操作の対象にしていないため一覧に残り続けることを確認する
    // (id スコープの削除が正しく効いていて、テナントの全拠点を消していないことの検証)
    await expect(page.getByText(OTHER_LOCATION_NAME)).toBeVisible();

    // ダッシュボードのフィルタピルからも消えることを確認する
    await page.goto('/dashboard');
    await expect(page.getByRole('link', { name: new RegExp(LOCATION_NAME) })).toHaveCount(0);
    // 対照群の別拠点のピルは引き続き表示されることを確認する
    await expect(page.getByRole('link', { name: new RegExp(OTHER_LOCATION_NAME) })).toBeVisible();
  });
});
