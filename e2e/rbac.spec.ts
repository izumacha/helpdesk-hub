// Playwright のテスト DSL と Page 型 (ページ操作の API)
import { test, expect, Page } from '@playwright/test';

// Issue #69: verify requester RBAC boundaries and middleware 401 behaviour.
// Seed data assumed: see `prisma/seed.ts`.
//   - requester1@example.com owns `seed-t-01` (New)
//   - requester3@example.com owns `seed-t-04` (InProgress)
// テスト用の依頼者ユーザー (シードデータと一致)
const REQUESTER1 = 'requester1@example.com';
// REQUESTER1 が所有しているチケット ID
const OWN_TICKET_ID = 'seed-t-01';
// 別の依頼者 (requester3) が所有しているチケット ID
const OTHERS_TICKET_ID = 'seed-t-04';

// 共通ログイン手順 (各テストの前処理で再利用)
async function login(page: Page, email: string) {
  // ログインページへ遷移
  await page.goto('/login');
  // メールアドレスを入力
  await page.getByLabel(/メールアドレス|Email/i).fill(email);
  // 共通パスワードを入力
  await page.getByLabel(/パスワード|Password/i).fill('password123');
  // ログインボタンを押下
  await page.getByRole('button', { name: /ログイン/i }).click();
  // ロールに応じたリダイレクト先 (/dashboard か /tickets) まで待機
  await page.waitForURL(/\/dashboard|\/tickets/);
}

// 依頼者ロールに対する権限 (RBAC) 境界の検証
test.describe('requester RBAC 境界', () => {
  // 自分以外のチケット ID を URL バーに直接入れても 404 になること
  test('他リクエスタのチケット詳細を直接 URL で開くと not-found になる', async ({ page }) => {
    // requester1 でログイン
    await login(page, REQUESTER1);
    // requester3 が持つチケットへ直接アクセス
    const res = await page.goto(`/tickets/${OTHERS_TICKET_ID}`);
    // ページレベルの notFound() で 404 が返る
    expect(res?.status()).toBe(404);
  });

  // 自分のチケットでも、エージェント向け操作 UI は表示されないこと
  test('自分のチケット詳細ではステータス/優先度/担当/エスカレーション/FAQ 操作 UI が見えない', async ({
    page,
  }) => {
    // requester1 でログイン
    await login(page, REQUESTER1);
    // 自分のチケット詳細へ遷移
    await page.goto(`/tickets/${OWN_TICKET_ID}`);
    // 本文セクションは表示される (閲覧自体はできる)
    await expect(page.getByText('問い合わせ内容')).toBeVisible();

    // Sidebar dropdowns are agent-only. Requesters see the value as plain text.
    // メイン領域に <select> が無いこと (ステータス/優先度/担当変更はエージェント専用)
    await expect(page.locator('main select')).toHaveCount(0);

    // Escalation trigger / FAQ candidate controls are agent-only.
    // エスカレーションボタンが無いこと
    await expect(page.getByRole('button', { name: /エスカレーション/ })).toHaveCount(0);
    // FAQ候補ボタンが無いこと
    await expect(page.getByRole('button', { name: /FAQ候補/ })).toHaveCount(0);

    // Comment input is still available to the creator.
    // コメント入力欄は依頼者でも利用可能
    await expect(page.getByPlaceholder(/コメント/)).toBeVisible();
  });
});

// middleware が API ルートに対して 401 を返す動作の検証
test.describe('middleware の API 401', () => {
  // セッション無しで POST /api/tickets すると middleware が 401 JSON を返す
  test('未認証で POST /api/tickets すると 401 を返す', async ({ request }) => {
    // 認証ヘッダ無しで API を叩く
    const res = await request.post('/api/tickets', {
      data: { title: 'unauthenticated', body: 'no session' },
    });
    // 401 ステータスを期待
    expect(res.status()).toBe(401);
    // レスポンス JSON を取得 (パース失敗時は null)
    const payload = await res.json().catch(() => null);
    // エラーメッセージに「認証」を含むこと
    expect(payload?.error).toMatch(/認証/);
  });

  // SSE ストリームも未認証では 401 になる
  test('未認証で GET /api/notifications/stream すると 401 を返す', async ({ request }) => {
    // 認証無しで通知ストリームへ GET
    const res = await request.get('/api/notifications/stream');
    // 401 ステータスを期待
    expect(res.status()).toBe(401);
  });
});
