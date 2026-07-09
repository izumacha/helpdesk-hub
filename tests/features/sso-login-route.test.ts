// GET /api/auth/sso/[tenantId]/login のレート制限テスト。
// 監査で発見したギャップ: 同じ SSO エンドポイント群のうち acs/route.ts (sso-acs-route.test.ts)
// だけがレート制限済みで、この /login エンドポイントには無かった。未認証で到達でき、
// AuthnRequest 生成という相応のコストがかかる処理を都度行うため、acs と同じ二段構えの
// レート制限を追加した。このテストはレート制限が正しく効くことに焦点を当てる。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRateLimits } from '@/lib/rate-limit';

const TENANT_ID = 'tenant-1';

// loadEnabledSsoContext を「常に SSO 利用可能」に固定する (テナント単位レート制限の検証に必要)
vi.mock('@/lib/sso-context', () => ({
  loadEnabledSsoContext: vi.fn(async () => ({
    ok: true,
    tenant: { id: TENANT_ID, name: 'テスト組織' },
    config: { idpEntityId: 'https://idp.example.com/entity' },
    baseUrl: 'http://localhost:3000',
  })),
}));

// createSamlInstance / getSsoLoginUrl をモックし、実際の SAML 処理を経由せず IdP URL を返す
vi.mock('@/lib/saml', () => ({
  createSamlInstance: vi.fn(() => ({})),
  getSsoLoginUrl: vi.fn(async () => 'https://idp.example.com/sso/login?SAMLRequest=xxx'),
}));

// リクエストを 1 件送るヘルパー
async function getLogin(tenantId: string): Promise<Response> {
  const { GET } = await import('@/app/api/auth/sso/[tenantId]/login/route');
  const req = new Request(`http://localhost:3000/api/auth/sso/${tenantId}/login`);
  return GET(req, { params: Promise.resolve({ tenantId }) });
}

describe('GET /api/auth/sso/[tenantId]/login のレート制限', () => {
  beforeEach(() => {
    __resetRateLimits();
  });

  // 固定キーの全体レート制限 (60秒60回) を超えると 429 を返す
  it('未認証全体のレート制限を超えると429を返す', async () => {
    for (let i = 0; i < 60; i++) {
      const res = await getLogin(`tenant-${i}`);
      expect(res.status).not.toBe(429);
    }
    const res = await getLogin('tenant-over-limit');
    expect(res.status).toBe(429);
  });

  // テナント単位のレート制限 (60秒20回) を超えると429を返す (同一テナントへの連打)
  it('同一テナントへの連打はテナント単位のレート制限で429を返す', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await getLogin(TENANT_ID);
      expect(res.status).not.toBe(429);
    }
    const res = await getLogin(TENANT_ID);
    expect(res.status).toBe(429);
  });

  // レート制限内であれば通常どおり IdP のログイン URL へ 303 リダイレクトされる
  it('レート制限内なら通常どおりIdPのログインURLへリダイレクトする', async () => {
    const res = await getLogin(TENANT_ID);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://idp.example.com/sso/login?SAMLRequest=xxx');
  });
});
