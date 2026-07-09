// POST /api/auth/sso/[tenantId]/acs のレート制限テスト。
// 監査で発見したギャップ: 他の未認証受信エンドポイント (inbound-line/inbound-email) と異なり、
// この ACS エンドポイントにはレート制限が無かった。ACS は未認証で到達でき、XML パース + 署名検証
// という CPU コストの高い処理をリクエストごとに行うため、二段構えのレート制限を追加した。
// このテストは SAML 検証そのものではなく、レート制限が正しく効くことに焦点を当てる
// (SAMLResponse を意図的に省略し、レート制限チェックの後段で sso-invalid になることを利用する)。

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

// リクエストを 1 件送るヘルパー (SAMLResponse は意図的に省略する)
async function postAcs(tenantId: string): Promise<Response> {
  const { POST } = await import('@/app/api/auth/sso/[tenantId]/acs/route');
  const req = new Request(`http://localhost:3000/api/auth/sso/${tenantId}/acs`, {
    method: 'POST',
    body: new URLSearchParams(), // SAMLResponse フィールドなし
  });
  return POST(req, { params: Promise.resolve({ tenantId }) });
}

describe('POST /api/auth/sso/[tenantId]/acs のレート制限', () => {
  beforeEach(() => {
    __resetRateLimits();
  });

  // 固定キーの全体レート制限 (60秒60回) を超えると 429 を返す
  it('未認証全体のレート制限を超えると429を返す', async () => {
    for (let i = 0; i < 60; i++) {
      const res = await postAcs(`tenant-${i}`);
      expect(res.status).not.toBe(429);
    }
    const res = await postAcs('tenant-over-limit');
    expect(res.status).toBe(429);
  });

  // テナント単位のレート制限 (60秒20回) を超えると429を返す (同一テナントへの連打)
  it('同一テナントへの連打はテナント単位のレート制限で429を返す', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await postAcs(TENANT_ID);
      expect(res.status).not.toBe(429);
    }
    const res = await postAcs(TENANT_ID);
    expect(res.status).toBe(429);
  });

  // レート制限内であれば SAMLResponse 欠落により sso-invalid へリダイレクトされる
  // (429 ではなく通常のエラーハンドリングが働くことの確認)
  it('レート制限内ならSAMLResponse欠落で通常どおりsso-invalidにリダイレクトする', async () => {
    const res = await postAcs(TENANT_ID);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('error=sso-invalid');
  });
});
