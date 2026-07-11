// GET /api/tickets/export (CSV エクスポート) のテスト。
// フォローアップ (2026-07-11): エクスポートに「内容」列が無く、CSV インポート (「内容」列に
// 対応済み) との往復ができなかった不備の回帰テスト。
// 認証・レート制限・tenantId スコープはメモリアダプタとモックで完結させる。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
import { __resetRateLimits } from '@/lib/rate-limit';

const TENANT = 'default-tenant';
const AGENT_ID = 'u-agt-1';

let store: Store;
let repos: Repos;

vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: AGENT_ID, role: 'agent', tenantId: TENANT },
  }),
}));

function seedTenant() {
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode: 'lite',
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    subscriptionPlan: 'free',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    createdAt: new Date(),
  });
  store.users.set(AGENT_ID, {
    id: AGENT_ID,
    email: 'agent1@example.com',
    name: 'エージェント1',
    passwordHash: 'x',
    role: 'agent',
    tenantId: TENANT,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  __resetRateLimits();
  vi.resetModules();
  seedTenant();
});

describe('GET /api/tickets/export', () => {
  // 回帰テスト: CSV インポートは「内容」列を取り込めるのに、エクスポートには出力されず
  // 往復 (エクスポート→編集→再インポート) でチケット本文が失われていた
  it('CSV に「内容」列が含まれ、チケット本文がそのまま出力される', async () => {
    await repos.tickets.create({
      title: '複合機の紙詰まり',
      body: '3階の複合機で紙が詰まって印刷できません',
      priority: 'Medium',
      categoryId: null,
      creatorId: AGENT_ID,
      tenantId: TENANT,
      status: 'Open',
      resolutionDueAt: null,
    });

    const { GET } = await import('@/app/api/tickets/export/route');
    const res = await GET(new Request('http://localhost/api/tickets/export'));
    expect(res.status).toBe(200);
    const csv = await res.text();

    // ヘッダー行に「内容」列があること (BOM を除去してから比較)
    const headerLine = csv.replace(/^﻿/, '').split('\n')[0];
    expect(headerLine).toContain('内容');

    // データ行に本文がそのまま含まれていること
    expect(csv).toContain('3階の複合機で紙が詰まって印刷できません');
  });

  // 未認証は 401
  it('未認証は401を返す', async () => {
    vi.doMock('@/lib/auth', () => ({ auth: async () => null }));
    const { GET } = await import('@/app/api/tickets/export/route');
    const res = await GET(new Request('http://localhost/api/tickets/export'));
    expect(res.status).toBe(401);
  });
});
