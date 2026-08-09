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

// リクエストを 1 件送るヘルパー (既定では SAMLResponse フィールドを意図的に省略する)。
// /code-review ultra 指摘対応: body/headers を上書き可能にし、空文字・破損ボディの
// テストケースでの Request 構築の重複を排除する (§6 DRY)
async function postAcs(
  tenantId: string,
  init: { body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<Response> {
  const { POST } = await import('@/app/api/auth/sso/[tenantId]/acs/route');
  const req = new Request(`http://localhost:3000/api/auth/sso/${tenantId}/acs`, {
    method: 'POST',
    body: init.body ?? new URLSearchParams(), // 既定: SAMLResponse フィールドなし
    ...(init.headers ? { headers: init.headers } : {}),
  });
  return POST(req, { params: Promise.resolve({ tenantId }) });
}

// 「レート制限 (429) ではなく通常のエラー処理で sso-invalid へ戻された」ことを表明する共通ヘルパー。
// この 2 行は 4 箇所のテストで同じなので 1 箇所に集約する (§6 DRY)
function expectSsoInvalidRedirect(res: Response): void {
  // 303 See Other でブラウザを GET 遷移させる
  expect(res.status).toBe(303);
  // 遷移先はログイン画面で、理由コードは sso-invalid
  expect(res.headers.get('location')).toContain('error=sso-invalid');
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

  // 「レート制限内なら 429 ではなく sso-invalid が返る」ケースは、下の監査記録テスト
  // (SAMLResponse 欠落) が同じリクエストで同じ表明を含んでいるため、ここには重複して置かない
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
  // (レート制限内で 429 ではなく sso-invalid が返ることの確認も兼ねる)
  it('SAMLResponse欠落の拒否をsso_assertion_rejectedとして監査に記録する', async () => {
    const res = await postAcs(TENANT_ID);
    expectSsoInvalidRedirect(res);
    expectSingleRejectedAudit();
  });

  // SAMLResponse が空文字の POST も監査に残る
  it('SAMLResponse空文字の拒否をsso_assertion_rejectedとして監査に記録する', async () => {
    // フィールドはあるが空のフォームボディで送る
    const res = await postAcs(TENANT_ID, { body: new URLSearchParams({ SAMLResponse: '' }) });
    expectSsoInvalidRedirect(res);
    expectSingleRejectedAudit();
  });

  // formData() のパース自体が失敗するボディ (フォームでない Content-Type) も監査に残る
  it('ボディ破損(formDataパース失敗)の拒否をsso_assertion_rejectedとして監査に記録する', async () => {
    // formData() が throw する Content-Type と壊れた本文で送る
    const res = await postAcs(TENANT_ID, {
      body: '{"broken":',
      headers: { 'Content-Type': 'application/json' },
    });
    expectSsoInvalidRedirect(res);
    expectSingleRejectedAudit();
  });
});

describe('POST /api/auth/sso/[tenantId]/acs のリクエストサイズ上限', () => {
  // ルート側の上限 (MAX_ACS_BODY_BYTES = 1MB) と同じ値。フォーム形式のまま送ることで
  // 「サイズ検査がフォームのパースより先に効く」ことも同時に確かめられる
  const MAX_BYTES = 1024 * 1024;
  // フォーム本文として解釈させるための Content-Type
  const FORM_CONTENT_TYPE = { 'Content-Type': 'application/x-www-form-urlencoded' };
  // 上限を確実に超える実本文 (Content-Length を明示しない経路の検証に使う)
  const OVERSIZED_BODY = `SAMLResponse=${'A'.repeat(MAX_BYTES)}`;

  // ヘッダの申告だけで上限超過と分かる場合は、本文を読む前に打ち切る。
  // 本文自体は数バイトしかないので、実バイト数の検査だけならすり抜けてしまう。
  // それでも 413 になる = ヘッダの事前検査が効いている、と言い切れる
  it('Content-Lengthヘッダが上限超過なら本文を読む前に413で拒否する', async () => {
    const res = await postAcs(TENANT_ID, {
      body: 'SAMLResponse=dummy', // 実サイズは上限内
      headers: { ...FORM_CONTENT_TYPE, 'Content-Length': String(MAX_BYTES + 1) }, // 申告だけ超過
    });
    // 413 Payload Too Large を返す (sso-invalid リダイレクトではない)
    expect(res.status).toBe(413);
  });

  // chunked 転送は Content-Length を省略できるため、読み込み後の実バイト数でも検査する。
  // Request は body から Content-Length を自動付与しないので、この経路がそのまま再現できる
  it('Content-Lengthが無くても実バイト数が上限超過なら413で拒否する', async () => {
    const res = await postAcs(TENANT_ID, { body: OVERSIZED_BODY, headers: FORM_CONTENT_TYPE });
    expect(res.status).toBe(413);
  });

  // サイズ超過は「アサーションを一切提示していない」ため監査には残さない
  // (失敗イベントの書き込み予算をゴミで消費させないという設計判断の固定)
  it('サイズ超過の拒否は監査ログに記録しない', async () => {
    await postAcs(TENANT_ID, { body: OVERSIZED_BODY, headers: FORM_CONTENT_TYPE });
    // 監査行は 1 件も増えていない
    expect([...store.authAuditLogs.values()]).toHaveLength(0);
  });

  // 上限内の本文はサイズ検査を通り、従来どおり SAMLResponse の検証まで進む
  it('上限内のボディはサイズ検査を通過して通常の検証に進む', async () => {
    // 上限内だが SAMLResponse が空なので、通常の入力検証で sso-invalid になる
    const res = await postAcs(TENANT_ID, { body: new URLSearchParams({ SAMLResponse: '' }) });
    expectSsoInvalidRedirect(res);
  });
});
