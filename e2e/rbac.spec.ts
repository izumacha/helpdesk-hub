import { test, expect, Page } from '@playwright/test';

// Issue #69: verify requester RBAC boundaries and middleware 401 behaviour.
// Seed data assumed: see `prisma/seed.ts`.
//   - requester1@example.com owns `seed-t-01` (New)
//   - requester3@example.com owns `seed-t-04` (InProgress)
const REQUESTER1 = 'requester1@example.com';
const OWN_TICKET_ID = 'seed-t-01';
const OTHERS_TICKET_ID = 'seed-t-04';

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel(/メールアドレス|Email/i).fill(email);
  await page.getByLabel(/パスワード|Password/i).fill('password123');
  await page.getByRole('button', { name: /ログイン/i }).click();
  await page.waitForURL(/\/dashboard|\/tickets/);
}

test.describe('requester RBAC 境界', () => {
  test('他リクエスタのチケット詳細を直接 URL で開くと not-found になる', async ({ page }) => {
    await login(page, REQUESTER1);
    const res = await page.goto(`/tickets/${OTHERS_TICKET_ID}`);
    expect(res?.status()).toBe(404);
  });

  test('自分のチケット詳細ではステータス/優先度/担当/エスカレーション/FAQ 操作 UI が見えない', async ({
    page,
  }) => {
    await login(page, REQUESTER1);
    await page.goto(`/tickets/${OWN_TICKET_ID}`);
    await expect(page.getByText('問い合わせ内容')).toBeVisible();

    // Sidebar dropdowns are agent-only. Requesters see the value as plain text.
    await expect(page.locator('main select')).toHaveCount(0);

    // Escalation trigger / FAQ candidate controls are agent-only.
    await expect(page.getByRole('button', { name: /エスカレーション/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /FAQ候補/ })).toHaveCount(0);

    // Comment input is still available to the creator.
    await expect(page.getByPlaceholder(/コメント/)).toBeVisible();
  });
});

test.describe('middleware の API 401', () => {
  test('未認証で POST /api/tickets すると 401 を返す', async ({ request }) => {
    const res = await request.post('/api/tickets', {
      data: { title: 'unauthenticated', body: 'no session' },
    });
    expect(res.status()).toBe(401);
    const payload = await res.json().catch(() => null);
    expect(payload?.error).toMatch(/認証/);
  });

  test('未認証で GET /api/notifications/stream すると 401 を返す', async ({ request }) => {
    const res = await request.get('/api/notifications/stream');
    expect(res.status()).toBe(401);
  });
});
