// GET /api/auth/sso/[tenantId]/metadata のレート制限テスト。
// 監査で発見したギャップ: 同じ SSO エンドポイント群のうち login/acs はレート制限済みで、
// このエンドポイントには無かった。未認証で到達でき、リクエストごとに DB 参照
// (tenants.findById) が発生するため、固定キーの全体レート制限を追加した。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRateLimits } from '@/lib/rate-limit';

const TENANT_ID = 'tenant-1';

// repos.tenants.findById を Enterprise プランのテナントに固定する
vi.mock('@/data', () => ({
  repos: {
    tenants: {
      findById: vi.fn(async (id: string) => ({
        id,
        name: 'テスト組織',
        subscriptionPlan: 'enterprise',
      })),
    },
  },
}));

// リクエストを 1 件送るヘルパー
async function getMetadata(tenantId: string): Promise<Response> {
  const { GET } = await import('@/app/api/auth/sso/[tenantId]/metadata/route');
  const req = new Request(`http://localhost:3000/api/auth/sso/${tenantId}/metadata`);
  return GET(req, { params: Promise.resolve({ tenantId }) });
}

describe('GET /api/auth/sso/[tenantId]/metadata のレート制限', () => {
  beforeEach(() => {
    __resetRateLimits();
  });

  // 固定キーの全体レート制限 (60秒60回) を超えると 429 を返す
  it('未認証全体のレート制限を超えると429を返す', async () => {
    for (let i = 0; i < 60; i++) {
      const res = await getMetadata(`tenant-${i}`);
      expect(res.status).not.toBe(429);
    }
    const res = await getMetadata('tenant-over-limit');
    expect(res.status).toBe(429);
  });

  // レート制限内であれば通常どおり SP メタデータ XML (200) を返す
  it('レート制限内なら通常どおりメタデータXMLを返す', async () => {
    const res = await getMetadata(TENANT_ID);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/xml');
  });
});
