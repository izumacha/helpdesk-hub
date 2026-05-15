// Playwright のテスト DSL と Page 型
import { test, expect, Page } from '@playwright/test';
// E2E 用に DB へ直接 fixture を投入するため Prisma Client を使う
import { PrismaClient, Role } from '../src/generated/prisma';
// ログイン可能なテストユーザーを作るためパスワードをハッシュ化する
import { hash } from 'bcryptjs';

// E2E 専用の第2テナント fixture ID 群
const TENANT_B_ID = 'e2e-tenant-b';
const TENANT_B_AGENT_EMAIL = 'e2e-tenant-b-agent@example.com';
const TENANT_B_REQUESTER_EMAIL = 'e2e-tenant-b-requester@example.com';
const TENANT_B_AGENT_ID = 'e2e-tenant-b-agent';
const TENANT_B_REQUESTER_ID = 'e2e-tenant-b-requester';
const TENANT_B_CATEGORY_ID = 'e2e-tenant-b-category';
const TENANT_B_TICKET_ID = 'e2e-tenant-b-ticket';
const TENANT_B_FAQ_ID = 'e2e-tenant-b-faq';
const TENANT_B_NOTIFICATION_ID = 'e2e-tenant-b-notification';

const TENANT_B_TICKET_TITLE = 'E2E テナントB専用チケット';
const TENANT_B_FAQ_QUESTION = 'E2E テナントB専用FAQ質問';
const TENANT_B_NOTIFICATION_MESSAGE = 'E2E テナントB専用通知';

// 既存 seed 側のデフォルトテナントユーザー
const DEFAULT_AGENT_EMAIL = 'agent1@example.com';
const DEFAULT_REQUESTER_EMAIL = 'requester1@example.com';
const DEFAULT_TENANT_TICKET_TITLE = 'VPN に接続できない';

// DB 直接投入用 Prisma Client
const prisma = new PrismaClient();

// 共通ログイン手順
async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel(/メールアドレス|Email/i).fill(email);
  await page.getByLabel(/パスワード|Password/i).fill('password123');
  await page.getByRole('button', { name: /ログイン/i }).click();
  await page.waitForURL(/\/dashboard|\/tickets/);
}

// 第2テナント fixture を投入する
async function seedTenantBFixture() {
  const passwordHash = await hash('password123', 12);

  await prisma.tenant.upsert({
    where: { id: TENANT_B_ID },
    update: {},
    create: { id: TENANT_B_ID, name: 'E2E テナントB', mode: 'lite' },
  });

  const agentB = await prisma.user.upsert({
    where: { email: TENANT_B_AGENT_EMAIL },
    update: { passwordHash, role: Role.agent, tenantId: TENANT_B_ID },
    create: {
      id: TENANT_B_AGENT_ID,
      email: TENANT_B_AGENT_EMAIL,
      name: 'E2E テナントB 担当者',
      passwordHash,
      role: Role.agent,
      tenantId: TENANT_B_ID,
    },
  });

  const requesterB = await prisma.user.upsert({
    where: { email: TENANT_B_REQUESTER_EMAIL },
    update: { passwordHash, role: Role.requester, tenantId: TENANT_B_ID },
    create: {
      id: TENANT_B_REQUESTER_ID,
      email: TENANT_B_REQUESTER_EMAIL,
      name: 'E2E テナントB 依頼者',
      passwordHash,
      role: Role.requester,
      tenantId: TENANT_B_ID,
    },
  });

  await prisma.category.upsert({
    where: { id: TENANT_B_CATEGORY_ID },
    update: { name: 'E2E テナントBカテゴリ', tenantId: TENANT_B_ID },
    create: { id: TENANT_B_CATEGORY_ID, name: 'E2E テナントBカテゴリ', tenantId: TENANT_B_ID },
  });

  await prisma.ticket.upsert({
    where: { id: TENANT_B_TICKET_ID },
    update: {
      title: TENANT_B_TICKET_TITLE,
      body: 'このチケットはテナントBからしか見えてはいけない。',
      status: 'Resolved',
      priority: 'Medium',
      creatorId: requesterB.id,
      assigneeId: agentB.id,
      categoryId: TENANT_B_CATEGORY_ID,
      tenantId: TENANT_B_ID,
      resolvedAt: new Date(),
    },
    create: {
      id: TENANT_B_TICKET_ID,
      title: TENANT_B_TICKET_TITLE,
      body: 'このチケットはテナントBからしか見えてはいけない。',
      status: 'Resolved',
      priority: 'Medium',
      creatorId: requesterB.id,
      assigneeId: agentB.id,
      categoryId: TENANT_B_CATEGORY_ID,
      tenantId: TENANT_B_ID,
      resolvedAt: new Date(),
    },
  });

  await prisma.faqCandidate.upsert({
    where: { id: TENANT_B_FAQ_ID },
    update: {
      question: TENANT_B_FAQ_QUESTION,
      answer: 'テナントB専用の回答。',
      status: 'Candidate',
      ticketId: TENANT_B_TICKET_ID,
      createdById: agentB.id,
      tenantId: TENANT_B_ID,
    },
    create: {
      id: TENANT_B_FAQ_ID,
      question: TENANT_B_FAQ_QUESTION,
      answer: 'テナントB専用の回答。',
      status: 'Candidate',
      ticketId: TENANT_B_TICKET_ID,
      createdById: agentB.id,
      tenantId: TENANT_B_ID,
    },
  });

  const defaultAgent = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_AGENT_EMAIL } });

  // userId はデフォルトテナントユーザー、tenantId はテナントBという不整合データを置く。
  // これが画面に出ないことで NotificationRepository.list の tenantId スコープを検証する。
  await prisma.notification.upsert({
    where: { id: TENANT_B_NOTIFICATION_ID },
    update: {
      userId: defaultAgent.id,
      tenantId: TENANT_B_ID,
      ticketId: TENANT_B_TICKET_ID,
      type: 'commented',
      message: TENANT_B_NOTIFICATION_MESSAGE,
      read: false,
    },
    create: {
      id: TENANT_B_NOTIFICATION_ID,
      userId: defaultAgent.id,
      tenantId: TENANT_B_ID,
      ticketId: TENANT_B_TICKET_ID,
      type: 'commented',
      message: TENANT_B_NOTIFICATION_MESSAGE,
      read: false,
    },
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('マルチテナント漏洩防止', () => {
  test.beforeAll(async () => {
    await seedTenantBFixture();
  });

  test.afterAll(async () => {
    await prisma.$disconnect();
  });

  test('テナントAの担当者からテナントBのチケット一覧・詳細・FAQ・通知が見えない', async ({ page }) => {
    await login(page, DEFAULT_AGENT_EMAIL);

    await page.goto('/tickets');
    await expect(page.getByText(TENANT_B_TICKET_TITLE)).toHaveCount(0);
    await expect(page.getByText(DEFAULT_TENANT_TICKET_TITLE)).toBeVisible();

    const detailResponse = await page.goto(`/tickets/${TENANT_B_TICKET_ID}`);
    expect(detailResponse?.status()).toBe(404);

    await page.goto('/faq');
    await expect(page.getByText(TENANT_B_FAQ_QUESTION)).toHaveCount(0);

    await page.goto('/notifications');
    await expect(page.getByText(TENANT_B_NOTIFICATION_MESSAGE)).toHaveCount(0);
  });

  test('テナントBの担当者はテナントBのチケットだけ見え、テナントAの代表チケットは見えない', async ({ page }) => {
    await login(page, TENANT_B_AGENT_EMAIL);

    await page.goto('/tickets');
    await expect(page.getByText(TENANT_B_TICKET_TITLE)).toBeVisible();
    await expect(page.getByText(DEFAULT_TENANT_TICKET_TITLE)).toHaveCount(0);
  });

  test('テナントAの依頼者はテナントBカテゴリIDでチケット作成できない', async ({ page }) => {
    await login(page, DEFAULT_REQUESTER_EMAIL);

    const result = await page.evaluate(async (categoryId) => {
      const res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: 'E2E クロステナントカテゴリ攻撃',
          body: '別テナントのカテゴリIDを指定して作成できないことを確認する。',
          priority: 'Medium',
          categoryId,
        }),
      });
      const payload = await res.json().catch(() => null);
      return { status: res.status, payload };
    }, TENANT_B_CATEGORY_ID);

    expect(result.status).toBe(422);
    expect(result.payload?.error).toMatch(/入力値/);
  });
});
