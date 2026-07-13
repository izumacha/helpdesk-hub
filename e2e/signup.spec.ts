// Playwright のテスト DSL と Page 型
import { test, expect } from '@playwright/test';
// メールの outbox ファイルを読むため
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
// E2E 後始末で作成テナント/ユーザーを消すため Prisma Client を使う
import { PrismaClient } from '../src/generated/prisma';

// DB 直接操作用 Prisma Client (後始末専用)
const prisma = new PrismaClient();

// Console EmailSender が書き出すアウトボックスファイル (プロジェクトルート直下。auth.spec.ts と共有)
const OUTBOX_PATH = path.join(process.cwd(), '.magic-link-outbox.jsonl');

// outbox から指定メール宛の URL を取得する (auth.spec.ts の readLastMagicLinkUrl と同じ設計)。
// - 並列テスト同士が同じファイルに append するので、テスト間でファイルをクリアしない
// - 指定 sinceMs より新しい entry の中から、最後 (= 直近) のものを返す
// - 最大 retries 回までポーリング (100ms 間隔)
async function readLastEmailUrl(
  email: string,
  urlPattern: RegExp,
  sinceMs: number,
  retries = 30,
): Promise<string> {
  for (let i = 0; i < retries; i++) {
    if (existsSync(OUTBOX_PATH)) {
      const lines = readFileSync(OUTBOX_PATH, 'utf8').trim().split('\n');
      for (let j = lines.length - 1; j >= 0; j--) {
        if (!lines[j]) continue;
        const entry = JSON.parse(lines[j]) as { to: string; text: string; sentAt: string };
        if (entry.to === email && new Date(entry.sentAt).getTime() >= sinceMs) {
          const match = entry.text.match(urlPattern);
          if (match) return match[0];
        }
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`outbox に ${email} 宛のリンクが見つかりませんでした`);
}

// テスト実行ごとに一意な組織名/管理者メール (リトライ間の衝突を避ける)
const FOUNDER_EMAIL = `e2e-founder-${Date.now()}@example.com`;

// テスト後に作成したテナント/ユーザーを掃除する
test.afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email: FOUNDER_EMAIL } });
  if (user) {
    // テナントを削除すると User は onDelete: Cascade で連鎖削除される
    await prisma.tenant.deleteMany({ where: { id: user.tenantId } });
  }
  await prisma.$disconnect();
});

test.describe('セルフサーブサインアップ', () => {
  test('サインアップして新しい組織を作成し、そのままログインできる', async ({ page }) => {
    // テスト開始時刻を控えておき、この時刻以降に書かれた outbox エントリだけを採用する
    const since = Date.now();

    // サインアップページからメールを送る
    await page.goto('/signup');
    await expect(page.getByRole('heading', { name: /HelpDesk Hub をはじめる/ })).toBeVisible();
    await page.getByLabel(/メールアドレス/i).fill(FOUNDER_EMAIL);
    await page.getByRole('button', { name: 'サインアップリンクを送る' }).click();
    // 確認メッセージが出たことを待つ (= サーバー側の send 完了 = outbox 書き込み完了)
    await expect(page.getByText('メールを確認してください')).toBeVisible();

    // outbox から since 以降に書かれたサインアップ完了 URL を取り出す
    const url = await readLastEmailUrl(
      FOUNDER_EMAIL,
      /https?:\/\/\S+\/signup\/complete\?token=\S+/,
      since,
    );

    // サインアップ完了ページを開く
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'サインアップを完了する' })).toBeVisible();

    // 組織名・氏名・パスワードを入力する (業種は未選択のままでよい)
    await page.getByLabel('組織名').fill('E2E サインアップ株式会社');
    await page.getByLabel('お名前').fill('E2E 創業者');
    await page.getByLabel(/パスワード/).fill('password123');
    await page.getByRole('button', { name: /組織を作成して利用を開始する/ }).click();

    // 作成される初代管理者は admin 権限なのでダッシュボードへ遷移する。
    // 新規テナントは既定で Lite モードのため、見出しは「ホーム」(Pro の「ダッシュボード」ではない)
    await page.waitForURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'ホーム' })).toBeVisible();

    // DB を直接確認: 新しいテナント + admin ユーザーが作られていること
    const user = await prisma.user.findUnique({ where: { email: FOUNDER_EMAIL } });
    expect(user?.role).toBe('admin');
    const tenant = await prisma.tenant.findUnique({ where: { id: user!.tenantId } });
    expect(tenant?.name).toBe('E2E サインアップ株式会社');
  });

  test('使用済みのサインアップリンクは再度完了できない', async ({ page, browser }) => {
    const since = Date.now();
    const onceEmail = `e2e-signup-once-${Date.now()}@example.com`;

    // 1 回目: サインアップを完了させる
    await page.goto('/signup');
    await page.getByLabel(/メールアドレス/i).fill(onceEmail);
    await page.getByRole('button', { name: 'サインアップリンクを送る' }).click();
    await expect(page.getByText('メールを確認してください')).toBeVisible();
    const url = await readLastEmailUrl(
      onceEmail,
      /https?:\/\/\S+\/signup\/complete\?token=\S+/,
      since,
    );

    const ctx1 = await browser.newContext();
    const p1 = await ctx1.newPage();
    await p1.goto(url);
    await p1.getByLabel('組織名').fill('一回目の組織');
    await p1.getByLabel('お名前').fill('一回目');
    await p1.getByLabel(/パスワード/).fill('password123');
    await p1.getByRole('button', { name: /組織を作成して利用を開始する/ }).click();
    await p1.waitForURL(/\/dashboard/);
    await ctx1.close();

    // 2 回目に同じリンクを開くと「無効/使用済み」の案内が出る
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    await p2.goto(url);
    await expect(p2.getByText(/このリンクは無効/)).toBeVisible();
    await ctx2.close();

    // 後始末
    const user = await prisma.user.findUnique({ where: { email: onceEmail } });
    if (user) {
      await prisma.tenant.deleteMany({ where: { id: user.tenantId } });
    }
  });

  // 既存アカウントのメールでサインアップを要求しても、新しいテナントは作られず
  // 通常のログインリンクが届くだけであること (列挙耐性 + 誤操作防止)
  test('既存アカウントのメールでは新しい組織を作らずログインリンクが届く', async ({ page }) => {
    const since = Date.now();
    await page.goto('/signup');
    await page.getByLabel(/メールアドレス/i).fill('admin@example.com');
    await page.getByRole('button', { name: 'サインアップリンクを送る' }).click();
    // 応答は新規メールと同じ「メールを確認してください」(列挙耐性)
    await expect(page.getByText('メールを確認してください')).toBeVisible();

    // outbox には /signup/complete ではなく通常のログインコールバック URL が届く
    const url = await readLastEmailUrl(
      'admin@example.com',
      /https?:\/\/\S+\/api\/auth\/magic-link\/callback\?token=\S+/,
      since,
    );
    expect(url).toContain('/api/auth/magic-link/callback');
  });
});
