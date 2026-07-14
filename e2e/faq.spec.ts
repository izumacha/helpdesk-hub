// Playwright のテスト DSL と Page 型 (ページ操作の API)
import { test, expect, Page } from '@playwright/test';

// フォローアップ (2026-07-14 #5): 監査で発見したギャップの解消。/faq は以前エージェント以上
// のみ閲覧可能で、依頼者は 404 で弾かれていた。公開済み FAQ を依頼者自身が読めるようになった
// ことを検証する (docs/smb-dx-pivot-plan.md §4.8 直後の §3.7 系フォローアップに相当)。
// Seed data assumed: see `prisma/seed.ts`.
//   - seed-t-03 の FAQ 候補は Published (「共有プリンターで...」)
//   - seed-t-08 の FAQ 候補は Candidate のまま (「ノートPCのバッテリー...」)
const PUBLISHED_QUESTION = /プリンターが見つかりません/;
const CANDIDATE_ONLY_QUESTION = /バッテリーの持ちが急に悪くなった/;

// 共通ログイン手順 (各テストの前処理で再利用)
async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel(/メールアドレス|Email/i).fill(email);
  await page.getByLabel(/パスワード|Password/i).fill('password123');
  await page.getByRole('button', { name: /ログイン/i }).click();
  await page.waitForURL(/\/dashboard|\/tickets/);
}

test.describe('/faq 依頼者向け閲覧', () => {
  // 依頼者は 404 にならず、公開済み FAQ のみ閲覧できること
  test('依頼者は公開済みFAQのみ閲覧でき、未公開の候補は見えない', async ({ page }) => {
    // 依頼者でログイン
    await login(page, 'requester1@example.com');
    // /faq へ遷移 (以前は 404 だった)
    const res = await page.goto('/faq');
    expect(res?.status()).toBe(200);

    // 公開済み FAQ の質問文が見えること
    await expect(page.getByText(PUBLISHED_QUESTION)).toBeVisible();
    // まだ候補 (未公開) の FAQ は見えないこと
    await expect(page.getByText(CANDIDATE_ONLY_QUESTION)).toHaveCount(0);

    // 公開/却下ボタン (エージェント専用の管理操作) が無いこと
    await expect(page.getByRole('button', { name: /公開する/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /却下/ })).toHaveCount(0);
  });

  // サイドバーにも FAQ (よくある質問) のリンクが表示されること (以前は agentOnly で非表示だった)
  test('依頼者のサイドバーにもFAQへのリンクが表示される', async ({ page }) => {
    await login(page, 'requester1@example.com');
    await page.goto('/dashboard').catch(() => page.goto('/tickets'));
    await expect(page.getByRole('link', { name: /よくある質問|FAQ/ })).toBeVisible();
  });
});

test.describe('/faq エージェント向け管理ビュー (回帰確認)', () => {
  // エージェントは従来どおり候補 (未公開) も含めて閲覧でき、公開/却下操作ができること
  test('エージェントは候補FAQも見え、公開/却下ボタンが使える', async ({ page }) => {
    await login(page, 'agent1@example.com');
    const res = await page.goto('/faq');
    expect(res?.status()).toBe(200);

    // 公開済み FAQ・候補 FAQ の両方が見えること (エージェント向けは全ステータス表示)
    await expect(page.getByText(PUBLISHED_QUESTION)).toBeVisible();
    await expect(page.getByText(CANDIDATE_ONLY_QUESTION)).toBeVisible();

    // 候補 (Candidate) の行には公開/却下ボタンが表示されること
    await expect(page.getByRole('button', { name: /公開する/ }).first()).toBeVisible();
  });
});
