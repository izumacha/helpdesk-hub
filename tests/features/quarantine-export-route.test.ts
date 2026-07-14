// GET /api/quarantine/export (フォローアップ 2026-07-14 #3) のテスト。
// 隔離記録一覧 (/quarantine) は 1 ページ 200 件までしか表示できず、CSV エクスポート自体を
// 持たなかったため、200 件を超えるテナントでは「さらに読み込む」を手作業で辿らないと古い行に
// 到達できず、まとめて保管・共有する手段も無かった不備の回帰テスト。GET /api/audit/export の
// テスト (audit-export-route.test.ts) と同じ構成で、認証・RBAC・レート制限・キーセットカーソルの
// ページ跨ぎ集計をメモリアダプタとモックで完結させる。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
import { __resetRateLimits } from '@/lib/rate-limit';
import { AUDIT_MAX_LIMIT } from '@/data/adapters/audit-pagination';

// エクスポート側の上限件数 (route.ts の MAX_QUARANTINE_EXPORT_ROWS と同値。テスト用に複製)
const MAX_QUARANTINE_EXPORT_ROWS = 10_000;

const TENANT = 'default-tenant';
const ADMIN_ID = 'u-admin-1';

let store: Store;
let repos: Repos;
let sessionRole = 'admin';

vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: ADMIN_ID, role: sessionRole, tenantId: TENANT },
  }),
}));

function seedTenant(plan: 'free' | 'pro' = 'free') {
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode: 'lite',
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    subscriptionPlan: plan,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    createdAt: new Date(),
  });
  store.users.set(ADMIN_ID, {
    id: ADMIN_ID,
    email: 'admin@example.com',
    name: '管理者',
    passwordHash: 'x',
    role: 'admin',
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
  sessionRole = 'admin';
  seedTenant();
});

describe('GET /api/quarantine/export', () => {
  // 回帰テスト: 1 ページ (AUDIT_MAX_LIMIT 件) を超える隔離記録があっても、
  // サーバー側でカーソルを前進させて全件 CSV に含めること (以前はエクスポート自体が存在しなかった)
  it('1 ページを超える件数でもカーソルを前進させて全件エクスポートする', async () => {
    const totalRows = AUDIT_MAX_LIMIT + 50;
    for (let i = 0; i < totalRows; i++) {
      await repos.quarantinedEmails.record({
        tenantId: TENANT,
        channel: 'email',
        reason: 'unknown_sender',
        senderAddress: `sender-${i}@example.com`,
        senderName: null,
        subject: `件名 ${i}`,
      });
    }

    const { GET } = await import('@/app/api/quarantine/export/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const csv = await res.text();

    // ヘッダー行 + データ行の合計行数を数える (末尾の空行を除く)
    const lines = csv
      .replace(/^﻿/, '')
      .split('\n')
      .filter((l) => l.length > 0);
    // ヘッダー1行 + totalRows 行がすべて含まれること (1 ページ分の 500 件で打ち切られていない)
    expect(lines.length).toBe(totalRows + 1);
    expect(res.headers.get('X-Truncated')).toBeNull();
  });

  // /code-review ultra 指摘対応 (audit/export と同じ回帰テスト): 総件数がちょうど
  // MAX_QUARANTINE_EXPORT_ROWS (AUDIT_MAX_LIMIT の倍数) のとき、「ちょうど limit 件で埋まった」
  // ヒューリスティックだけで truncated を判定すると、実際には全件取得済みなのに「一部のみ」と
  // 誤って警告してしまう回帰テスト
  it('総件数がちょうど上限件数のときは誤って truncated にしない', async () => {
    for (let i = 0; i < MAX_QUARANTINE_EXPORT_ROWS; i++) {
      await repos.quarantinedEmails.record({
        tenantId: TENANT,
        channel: 'line',
        reason: 'quota_exceeded',
        lineUserId: `line-user-${i}`,
      });
    }

    const { GET } = await import('@/app/api/quarantine/export/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const csv = await res.text();
    const lines = csv
      .replace(/^﻿/, '')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(MAX_QUARANTINE_EXPORT_ROWS + 1);
    expect(res.headers.get('X-Truncated')).toBeNull();
  }, 20_000);

  // 上記の反対系: 総件数が上限を実際に超えている場合は正しく truncated になること
  it('総件数が上限を超えているときは truncated になる', async () => {
    for (let i = 0; i < MAX_QUARANTINE_EXPORT_ROWS + 1; i++) {
      await repos.quarantinedEmails.record({
        tenantId: TENANT,
        channel: 'line',
        reason: 'quota_exceeded',
        lineUserId: `line-user-${i}`,
      });
    }

    const { GET } = await import('@/app/api/quarantine/export/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const csv = await res.text();
    const lines = csv
      .replace(/^﻿/, '')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(MAX_QUARANTINE_EXPORT_ROWS + 1);
    expect(res.headers.get('X-Truncated')).toBe('true');
    expect(res.headers.get('X-Total-Limit')).toBe(String(MAX_QUARANTINE_EXPORT_ROWS));
  }, 20_000);

  // 管理者以外 (agent) は 403 (画面側と同じ role === 'admin' 直接比較の RBAC)
  it('管理者以外は403を返す', async () => {
    sessionRole = 'agent';
    const { GET } = await import('@/app/api/quarantine/export/route');
    const res = await GET();
    expect(res.status).toBe(403);
  });

  // /quarantine 画面と同じくプランゲートは設けない (Free プランでの隔離を admin 自身が
  // 確認できる導線として有用なため。§3.2 フォローアップ再訪の方針)
  it('Free プランでも200を返す (プランゲートなし)', async () => {
    seedTenant('free');
    await repos.quarantinedEmails.record({
      tenantId: TENANT,
      channel: 'email',
      reason: 'plan_gate',
      senderAddress: 'someone@example.com',
      senderName: null,
      subject: '件名',
    });
    const { GET } = await import('@/app/api/quarantine/export/route');
    const res = await GET();
    expect(res.status).toBe(200);
  });

  // レート制限 (3 回/分) を超えると 429
  it('レート制限を超えると429を返す', async () => {
    const { GET } = await import('@/app/api/quarantine/export/route');
    // 上限 (3 回) までは通常どおり成功する
    for (let i = 0; i < 3; i++) {
      const res = await GET();
      expect(res.status).toBe(200);
    }
    // 4 回目はレート制限に引っかかる
    const res = await GET();
    expect(res.status).toBe(429);
  });

  // 未認証は 401 (vi.doMock は以降の動的 import に永続するため、他のケースへ影響しないよう最後に置く)
  it('未認証は401を返す', async () => {
    vi.doMock('@/lib/auth', () => ({ auth: async () => null }));
    const { GET } = await import('@/app/api/quarantine/export/route');
    const res = await GET();
    expect(res.status).toBe(401);
  });
});
