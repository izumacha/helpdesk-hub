// Playwright のテスト DSL と Page 型 (ページ操作の API)
import { test, expect, Page } from '@playwright/test';
// フォローアップ (2026-07-14 #6) 用の fixture を DB へ直接投入するため Prisma Client を使う
import { PrismaClient } from '../src/generated/prisma';

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

// フォローアップ (2026-07-14 #6): 公開後に誤りへ気付いても訂正・取り下げする手段が一つも無かった
// ギャップの解消。編集後の質問文で新たにマッチさせたいため、共有 seed (プリンター/バッテリー) とは
// 独立した専用 fixture を使う。

// DB 直接投入用 Prisma Client
const prisma = new PrismaClient();
// この describe 専用の fixture ID 群
const EDIT_TICKET_ID = 'e2e-faq-edit-ticket';
const EDIT_FAQ_ID = 'e2e-faq-edit-faq';
const UNPUBLISH_TICKET_ID = 'e2e-faq-unpublish-ticket';
const UNPUBLISH_FAQ_ID = 'e2e-faq-unpublish-faq';
// 質問文には他の操作ボタン名 (公開する/却下/非公開にする 等) と紛らわしい単語を含めない。
// aria-label は「{質問文} を編集」のように質問文をそのまま前置するため、質問文自体に
// ボタン名の部分文字列が入っていると getByRole の部分一致でボタンを取り違える
// (実際に「編集前」の「編集」が「編集」ボタン検索にヒットし、同じ行の他ボタンとも
// 曖昧一致して strict mode violation を起こした失敗を踏まえた対策)
const ORIGINAL_QUESTION = 'E2Eテスト用の質問（変更前）';
const EDITED_QUESTION = 'E2Eテスト用の質問（変更後）';
const UNPUBLISH_QUESTION = 'E2E取り下げ対象の質問';

// 編集/非公開化テスト用の Candidate/Published FAQ を default-tenant に投入する
async function seedEditFixtures() {
  const agent = await prisma.user.findUniqueOrThrow({ where: { email: 'agent1@example.com' } });
  const tenantId = agent.tenantId;

  await prisma.ticket.upsert({
    where: { id: EDIT_TICKET_ID },
    update: { status: 'Resolved', tenantId },
    create: {
      id: EDIT_TICKET_ID,
      title: 'E2E編集用チケット',
      body: '編集テスト用の本文',
      status: 'Resolved',
      priority: 'Medium',
      creatorId: agent.id,
      tenantId,
    },
  });
  await prisma.faqCandidate.upsert({
    where: { id: EDIT_FAQ_ID },
    update: { question: ORIGINAL_QUESTION, answer: '編集前の回答', status: 'Candidate' },
    create: {
      id: EDIT_FAQ_ID,
      question: ORIGINAL_QUESTION,
      answer: '編集前の回答',
      status: 'Candidate',
      ticketId: EDIT_TICKET_ID,
      createdById: agent.id,
      tenantId,
    },
  });

  await prisma.ticket.upsert({
    where: { id: UNPUBLISH_TICKET_ID },
    update: { status: 'Resolved', tenantId },
    create: {
      id: UNPUBLISH_TICKET_ID,
      title: 'E2E非公開化用チケット',
      body: '非公開化テスト用の本文',
      status: 'Resolved',
      priority: 'Medium',
      creatorId: agent.id,
      tenantId,
    },
  });
  await prisma.faqCandidate.upsert({
    where: { id: UNPUBLISH_FAQ_ID },
    update: { question: UNPUBLISH_QUESTION, answer: '非公開化前の回答', status: 'Published' },
    create: {
      id: UNPUBLISH_FAQ_ID,
      question: UNPUBLISH_QUESTION,
      answer: '非公開化前の回答',
      status: 'Published',
      ticketId: UNPUBLISH_TICKET_ID,
      createdById: agent.id,
      tenantId,
    },
  });
}

test.describe('/faq エージェント向け編集・非公開化', () => {
  // このブロック内のテストは同じ fixture (質問文) を編集・状態変更するため、
  // 他テストと並行実行して競合しないよう serial 化する
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await seedEditFixtures();
  });

  test.afterAll(async () => {
    await prisma.$disconnect();
  });

  // 「編集」ボタンからその場で質問/回答を書き換えられること (公開後の訂正手段)
  test('エージェントはFAQの質問/回答をその場編集できる', async ({ page }) => {
    await login(page, 'agent1@example.com');
    await page.goto('/faq');

    // 対象カード内の「編集」ボタンを開く。同じ行に「公開する」「却下」ボタンも並ぶため、
    // 部分一致だと質問文自体に含まれる語と誤マッチしうる。aria-label の完全一致で対象を絞る
    const card = page.locator('div', { hasText: ORIGINAL_QUESTION }).last();
    await card.getByRole('button', { name: `${ORIGINAL_QUESTION} を編集`, exact: true }).click();

    // 質問欄を新しい文言に書き換えて保存。getByLabel('質問') は aria-label に質問文自体を
    // 含む他のボタンとも部分一致してしまう (Playwright の getByLabel は <label> 関連付けだけで
    // なく aria-label 属性を持つ任意の要素にもマッチするため) ので、対象カード内の最初の
    // テキストエリア (質問欄) を直接指定する
    await card.getByRole('textbox').first().fill(EDITED_QUESTION);
    await page.getByRole('button', { name: '保存' }).click();

    // 編集後の質問文が表示され、編集前の文言は消えること
    await expect(page.getByText(EDITED_QUESTION)).toBeVisible();
    await expect(page.getByText(ORIGINAL_QUESTION)).toHaveCount(0);
  });

  // 「非公開にする」ボタンから Published を取り下げられること
  test('エージェントは公開済みFAQを非公開にできる', async ({ page }) => {
    await login(page, 'agent1@example.com');
    await page.goto('/faq');

    // 対象カード内の「非公開にする」ボタンをクリック (aria-label の完全一致で対象を絞る)
    const card = page.locator('div', { hasText: UNPUBLISH_QUESTION }).last();
    await card
      .getByRole('button', { name: `${UNPUBLISH_QUESTION} を非公開にする`, exact: true })
      .click();

    // 非公開化後は「非公開にする」ボタンも「公開する」ボタンも出ないこと (Rejected 状態)。
    // Server Action によるソフトナビゲーションで DOM が更新されるのを自動リトライで待つ
    const reloadedCard = page.locator('div', { hasText: UNPUBLISH_QUESTION }).last();
    await expect(reloadedCard.getByRole('button', { name: '非公開にする' })).toHaveCount(0);
    await expect(reloadedCard.getByRole('button', { name: '公開する' })).toHaveCount(0);
  });
});
