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

  // 回帰テスト (フォローアップ 2026-07-11 #2): 期限日列は従来「解決期限」という別名・
  // ja-JP ロケール書式 (例 '2026/3/5') で出力しており、CSV インポートが期待する列名「期限日」・
  // 'YYYY-MM-DD' 厳密形式と一致せず往復できなかった。列名・書式ともインポート側と揃っていることを検証する
  it('期限日列がインポートと同じ列名・YYYY-MM-DD形式で出力される', async () => {
    await repos.tickets.create({
      title: '複合機の紙詰まり',
      body: '',
      priority: 'Medium',
      categoryId: null,
      creatorId: AGENT_ID,
      tenantId: TENANT,
      status: 'Open',
      // 月・日が1桁の日付でゼロ埋めが効いているか確認する
      resolutionDueAt: new Date('2026-01-09T00:30:00.000Z'), // JST 2026-01-09 09:30
    });

    const { GET } = await import('@/app/api/tickets/export/route');
    const res = await GET(new Request('http://localhost/api/tickets/export'));
    const csv = await res.text();

    // ヘッダーに CSV インポートと同じ列名「期限日」があること (旧列名「解決期限」ではない)
    const headerLine = csv.replace(/^﻿/, '').split('\n')[0];
    expect(headerLine).toContain('期限日');
    expect(headerLine).not.toContain('解決期限');

    // インポートの parseDateLocal が要求する厳密な 'YYYY-MM-DD' (ゼロ埋め済み) で出力されること
    expect(csv).toContain('2026-01-09');
  });

  // 回帰テスト (フォローアップ 2026-07-15 #3): 「起票日時」列は従来 formatDateTimeJP
  // (ja-JP ロケール書式、例 '2026/1/9 9:30:00') で出力しており、CSV インポートが要求する
  // 'YYYY-MM-DD HH:mm:ss' 厳密形式と一致せず往復できなかった。インポート側 (parseDateTimeJST) が
  // 要求する形式で出力されていることを検証する
  it('起票日時列がインポートと同じ YYYY-MM-DD HH:mm:ss 形式で出力される', async () => {
    await repos.tickets.create({
      title: '複合機の紙詰まり',
      body: '',
      priority: 'Medium',
      categoryId: null,
      creatorId: AGENT_ID,
      tenantId: TENANT,
      status: 'Open',
      resolutionDueAt: null,
      // 月・日・時・分・秒が1桁の日時でゼロ埋めが効いているか確認する
      createdAt: new Date('2026-01-08T15:30:05.000Z'), // JST 2026-01-09 00:30:05
    });

    const { GET } = await import('@/app/api/tickets/export/route');
    const res = await GET(new Request('http://localhost/api/tickets/export'));
    const csv = await res.text();

    // ヘッダーに CSV インポートと同じ列名「起票日時」があること
    const headerLine = csv.replace(/^﻿/, '').split('\n')[0];
    expect(headerLine).toContain('起票日時');

    // インポートの parseDateTimeJST が要求する厳密な 'YYYY-MM-DD HH:mm:ss' (ゼロ埋め済み・
    // 24時間表記) で出力されること (ja-JP ロケールの '2026/1/9 0:30:05' ではない)
    expect(csv).toContain('2026-01-09 00:30:05');
  });

  // 未認証は 401
  it('未認証は401を返す', async () => {
    vi.doMock('@/lib/auth', () => ({ auth: async () => null }));
    const { GET } = await import('@/app/api/tickets/export/route');
    const res = await GET(new Request('http://localhost/api/tickets/export'));
    expect(res.status).toBe(401);
  });
});
