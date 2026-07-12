// GET /api/audit/export (§4.2.1 フォローアップ再訪) のテスト。
// 監査ログ画面は 1 ページ 200 件までしか表示・エクスポートできず、古い行に「さらに読み込む」を
// 手作業で辿らないと到達できなかった不備の回帰テスト。認証・RBAC・プランゲート・レート制限・
// キーセットカーソルのページ跨ぎ集計をメモリアダプタとモックで完結させる。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
import { __resetRateLimits } from '@/lib/rate-limit';
import { AUDIT_MAX_LIMIT } from '@/data/adapters/audit-pagination';

// エクスポート側の上限件数 (route.ts の MAX_AUDIT_EXPORT_ROWS と同値。テスト用に複製)
const MAX_AUDIT_EXPORT_ROWS = 10_000;

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

function seedTenant(plan: 'free' | 'pro' = 'pro') {
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode: 'pro',
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

describe('GET /api/audit/export', () => {
  // 回帰テスト: 1 ページ (AUDIT_MAX_LIMIT 件) を超える設定変更監査ログがあっても、
  // サーバー側でカーソルを前進させて全件 CSV に含めること (以前は /audit 画面同様
  // 1 ページ分で打ち切られていた)
  it('1 ページを超える件数でもカーソルを前進させて全件エクスポートする', async () => {
    // AUDIT_MAX_LIMIT (500) を超える件数の設定変更監査ログを記録する
    const totalRows = AUDIT_MAX_LIMIT + 50;
    for (let i = 0; i < totalRows; i++) {
      await repos.settingsAudit.record({
        tenantId: TENANT,
        actorId: ADMIN_ID,
        action: 'tenant_mode_update',
      });
    }

    const { GET } = await import('@/app/api/audit/export/route');
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

  // /code-review ultra 指摘対応: 総件数がちょうど MAX_AUDIT_EXPORT_ROWS (AUDIT_MAX_LIMIT の倍数)
  // のとき、fetchAuditFeedPage の hasMore ヒューリスティック (「ちょうど limit 件で埋まった」)
  // だけで truncated を判定すると、実際には全件取得済みなのに「一部のみ」と誤って警告してしまう
  // 回帰テスト。ちょうど上限件数のログを用意し、続きが無いことを確認したうえで truncated が
  // false になることを検証する
  it(
    '総件数がちょうど上限件数のときは誤って truncated にしない',
    async () => {
      for (let i = 0; i < MAX_AUDIT_EXPORT_ROWS; i++) {
        await repos.settingsAudit.record({
          tenantId: TENANT,
          actorId: ADMIN_ID,
          action: 'tenant_mode_update',
        });
      }

      const { GET } = await import('@/app/api/audit/export/route');
      const res = await GET();
      expect(res.status).toBe(200);
      const csv = await res.text();
      const lines = csv
        .replace(/^﻿/, '')
        .split('\n')
        .filter((l) => l.length > 0);
      // ヘッダー1行 + ちょうど MAX_AUDIT_EXPORT_ROWS 行が含まれること
      expect(lines.length).toBe(MAX_AUDIT_EXPORT_ROWS + 1);
      // 続きは無いため truncated ヘッダーは付かない (誤検知の回帰防止)
      expect(res.headers.get('X-Truncated')).toBeNull();
    },
    20_000,
  );

  // 上記の反対系: 総件数が上限を実際に超えている場合は正しく truncated になること
  // (誤検知防止の修正が「常に truncated=false にする」退行になっていないことを確認する)
  it(
    '総件数が上限を超えているときは truncated になる',
    async () => {
      for (let i = 0; i < MAX_AUDIT_EXPORT_ROWS + 1; i++) {
        await repos.settingsAudit.record({
          tenantId: TENANT,
          actorId: ADMIN_ID,
          action: 'tenant_mode_update',
        });
      }

      const { GET } = await import('@/app/api/audit/export/route');
      const res = await GET();
      expect(res.status).toBe(200);
      const csv = await res.text();
      const lines = csv
        .replace(/^﻿/, '')
        .split('\n')
        .filter((l) => l.length > 0);
      // ヘッダー1行 + 上限件数までに切り詰められること
      expect(lines.length).toBe(MAX_AUDIT_EXPORT_ROWS + 1);
      expect(res.headers.get('X-Truncated')).toBe('true');
      expect(res.headers.get('X-Total-Limit')).toBe(String(MAX_AUDIT_EXPORT_ROWS));
    },
    20_000,
  );

  // 管理者以外 (agent) は 403 (画面側と同じ role === 'admin' 直接比較の RBAC)
  it('管理者以外は403を返す', async () => {
    sessionRole = 'agent';
    const { GET } = await import('@/app/api/audit/export/route');
    const res = await GET();
    expect(res.status).toBe(403);
  });

  // Free プランは監査ログ機能自体が利用不可 (§6.1 料金プラン)
  it('Free プランは403を返す', async () => {
    seedTenant('free');
    const { GET } = await import('@/app/api/audit/export/route');
    const res = await GET();
    expect(res.status).toBe(403);
  });

  // レート制限 (3 回/分) を超えると 429
  it('レート制限を超えると429を返す', async () => {
    const { GET } = await import('@/app/api/audit/export/route');
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
    const { GET } = await import('@/app/api/audit/export/route');
    const res = await GET();
    expect(res.status).toBe(401);
  });
});
