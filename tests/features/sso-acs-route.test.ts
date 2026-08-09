// POST /api/auth/sso/[tenantId]/acs のレート制限テストと、ボディ取り出し段階の監査記録テスト。
// 監査で発見したギャップ (レート制限): 他の未認証受信エンドポイント (inbound-line/inbound-email) と
// 異なり、この ACS エンドポイントにはレート制限が無かった。ACS は未認証で到達でき、XML パース +
// 署名検証という CPU コストの高い処理をリクエストごとに行うため、二段構えのレート制限を追加した。
// /code-review ultra 指摘対応 (監査記録): SAMLResponse 欠落・ボディ破損での拒否 (sso-invalid) が
// AuthAuditLog に一切残らず、「成功・失敗とも全認証経路を記録する」不変条件から漏れていた。
// 記録されるようになったことをメモリアダプタ経由で検証する (sso-acs-replay.test.ts と同方式)。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRateLimits } from '@/lib/rate-limit';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
// 監査の失敗イベント書き込み予算をテスト間でリセットする (連打テストの消費を持ち越さない)。
// AUTH_AUDIT_UNKNOWN_EMAIL は本人を特定できない失敗経路で記録される代替メール (期待値の直書きを避ける)
import { AUTH_AUDIT_UNKNOWN_EMAIL, __resetAuthAuditThrottle } from '@/lib/auth-audit';
import { expectRateLimitTripsAfter } from './sso-rate-limit-assertions';

const TENANT_ID = 'tenant-1';

// 各テストで差し替える可変な依存 (Route import 前に値を入れる)
let store: Store;
let repos: Repos;

// @/data を差し替え (getter で beforeEach の上書きを反映。sso-acs-replay.test.ts と同方式)。
// 監査記録 (recordAuthAudit → repos.authAudit) がメモリアダプタに書き込むようにする
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

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

// 各テストの共通初期化: レート制限・監査予算・メモリストアを毎回まっさらにする
beforeEach(() => {
  __resetRateLimits();
  __resetAuthAuditThrottle();
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
});

describe('POST /api/auth/sso/[tenantId]/acs のレート制限', () => {
  // 固定キーの全体レート制限 (60秒60回) を超えると 429 を返す
  it('未認証全体のレート制限を超えると429を返す', async () => {
    await expectRateLimitTripsAfter((i) => postAcs(`tenant-${i}`), 60);
  });

  // テナント単位のレート制限 (60秒20回) を超えると429を返す (同一テナントへの連打)
  it('同一テナントへの連打はテナント単位のレート制限で429を返す', async () => {
    await expectRateLimitTripsAfter(() => postAcs(TENANT_ID), 20);
  });

  // レート制限内であれば SAMLResponse 欠落により sso-invalid へリダイレクトされる
  // (429 ではなく通常のエラーハンドリングが働くことの確認)
  it('レート制限内ならSAMLResponse欠落で通常どおりsso-invalidにリダイレクトする', async () => {
    const res = await postAcs(TENANT_ID);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('error=sso-invalid');
  });
});

describe('POST /api/auth/sso/[tenantId]/acs のボディ取り出し段階の監査記録', () => {
  // 記録された監査行が「検証不能なアサーション試行」として正しい形かを表明する共通ヘルパー
  function expectSingleRejectedAudit(): void {
    // メモリストアの監査行を取り出す
    const rows = [...store.authAuditLogs.values()];
    // ちょうど 1 件記録されている
    expect(rows).toHaveLength(1);
    // 種別は sso_assertion_rejected、メールは特定不能の代替値、テナントは URL から解決した値
    expect(rows[0]).toMatchObject({
      event: 'sso_assertion_rejected',
      email: AUTH_AUDIT_UNKNOWN_EMAIL,
      userId: null,
      tenantId: TENANT_ID,
    });
  }

  // SAMLResponse フィールドそのものが無い POST も監査に残る
  it('SAMLResponse欠落の拒否をsso_assertion_rejectedとして監査に記録する', async () => {
    const res = await postAcs(TENANT_ID);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('error=sso-invalid');
    expectSingleRejectedAudit();
  });

  // SAMLResponse が空文字の POST も監査に残る
  it('SAMLResponse空文字の拒否をsso_assertion_rejectedとして監査に記録する', async () => {
    const { POST } = await import('@/app/api/auth/sso/[tenantId]/acs/route');
    const req = new Request(`http://localhost:3000/api/auth/sso/${TENANT_ID}/acs`, {
      method: 'POST',
      body: new URLSearchParams({ SAMLResponse: '' }), // フィールドはあるが空
    });
    const res = await POST(req, { params: Promise.resolve({ tenantId: TENANT_ID }) });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('error=sso-invalid');
    expectSingleRejectedAudit();
  });

  // formData() のパース自体が失敗するボディ (フォームでない Content-Type) も監査に残る
  it('ボディ破損(formDataパース失敗)の拒否をsso_assertion_rejectedとして監査に記録する', async () => {
    const { POST } = await import('@/app/api/auth/sso/[tenantId]/acs/route');
    const req = new Request(`http://localhost:3000/api/auth/sso/${TENANT_ID}/acs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // formData() が throw する Content-Type
      body: '{"broken":',
    });
    const res = await POST(req, { params: Promise.resolve({ tenantId: TENANT_ID }) });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('error=sso-invalid');
    expectSingleRejectedAudit();
  });
});
