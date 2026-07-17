// POST /api/auth/sso/[tenantId]/acs のリプレイ防止テスト。
// 監査で発見したギャップ: ACS は署名・Issuer・Audience・期限を検証するが、有効期限内の同一
// SAMLResponse を攻撃者が複数回 POST しても検証は毎回成功してしまい (リプレイ攻撃)、盗聴された
// 1 通の正当なアサーションから無制限にログインセッションを発行できてしまっていた。
// このテストは実際に openssl で署名した SAMLResponse を使い、同一アサーションの 2 回目の POST が
// 拒否されること・異なるアサーションなら独立して成功することをメモリアダプタ経由で検証する。

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignedXml } from 'xml-crypto';

import { __resetRateLimits } from '@/lib/rate-limit';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
import { buildSpUrls } from '@/lib/saml';

const BASE_URL = 'http://localhost:3000'; // resolveAppBaseUrl() の test/dev フォールバック値と一致させる
const TENANT_ID = 'tenant-replay';
const IDP_ENTITY_ID = 'https://idp.example.com/entity';
const USER_EMAIL = 'agent@example.com';
const SP = buildSpUrls(BASE_URL, TENANT_ID);

// 各テストで差し替える可変な依存 (Route import 前に値を入れる)
let store: Store;
let repos: Repos;

// @/data を差し替え (getter で beforeEach の上書きを反映。trial-reminders-route.test.ts と同方式)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// ACS ルート自体は認証セッションを使わないが、loadEnabledSsoContext (sso-context.ts) が
// tenant-admin-gate 経由で '@/lib/auth' (next-auth) を静的 import しているため、テスト環境で
// 壊れがちな next-auth の依存解決を避けるためにモックする (delete-sso-config.test.ts と同方式)
vi.mock('@/lib/auth', () => ({
  auth: async () => null,
}));

// openssl が使えるかを判定する (使えない環境では署名付きテストをスキップする)
function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let privateKey = '';
let certPem = '';
let certB64 = '';
const hasOpenssl = opensslAvailable();

// openssl で RSA 鍵 + 自己署名証明書を 1 組生成し PEM とプロパティを返す (tests/saml.test.ts と同方式)
function generateKeyPair(): { key: string; certPem: string; certB64: string } {
  const dir = mkdtempSync(join(tmpdir(), 'saml-replay-test-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
        '-days',
        '2',
        '-nodes',
        '-subj',
        '/CN=test-idp',
      ],
      { stdio: 'ignore' },
    );
    const key = readFileSync(join(dir, 'k.pem'), 'utf8');
    const pem = readFileSync(join(dir, 'c.pem'), 'utf8');
    const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    return { key, certPem: pem, certB64: b64 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 指定のアサーション ID で署名付き SAML Response を生成し base64 で返す (tests/saml.test.ts と同方式)
function makeSignedResponse(assertionId: string): string {
  const now = Date.now();
  const issueInstant = new Date(now).toISOString();
  const notOnOrAfter = new Date(now + 5 * 60 * 1000).toISOString();
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${issueInstant}">` +
    `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${USER_EMAIL}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData Recipient="${SP.acsUrl}" NotOnOrAfter="${notOnOrAfter}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${issueInstant}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${SP.entityId}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${issueInstant}"><saml:AuthnContext>` +
    `<saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef>` +
    `</saml:AuthnContext></saml:AuthnStatement></saml:Assertion>`;
  const responseXml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r1" Version="2.0" IssueInstant="${issueInstant}" Destination="${SP.acsUrl}">` +
    `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `${assertion}</samlp:Response>`;
  const sig = new SignedXml({ privateKey, publicCert: certPem });
  sig.addReference({
    xpath: `//*[local-name(.)='Assertion']`,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  sig.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  sig.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
  sig.computeSignature(responseXml, {
    location: {
      reference: `//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']`,
      action: 'after',
    },
  });
  return Buffer.from(sig.getSignedXml()).toString('base64');
}

beforeAll(() => {
  if (!hasOpenssl) return;
  const pair = generateKeyPair();
  privateKey = pair.key;
  certPem = pair.certPem;
  certB64 = pair.certB64;
});

// リクエストを 1 件送るヘルパー
async function postAcs(samlResponseB64: string): Promise<Response> {
  const { POST } = await import('@/app/api/auth/sso/[tenantId]/acs/route');
  const req = new Request(`http://localhost:3000/api/auth/sso/${TENANT_ID}/acs`, {
    method: 'POST',
    body: new URLSearchParams({ SAMLResponse: samlResponseB64 }),
  });
  return POST(req, { params: Promise.resolve({ tenantId: TENANT_ID }) });
}

describe.skipIf(!hasOpenssl)('POST /api/auth/sso/[tenantId]/acs のリプレイ防止', () => {
  beforeEach(async () => {
    __resetRateLimits();
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;

    // Enterprise プラン (SSO 許可) のテナントを直接シードする (trial-reminders-route.test.ts と同方式)
    store.tenants.set(TENANT_ID, {
      id: TENANT_ID,
      name: 'リプレイ防止テスト組織',
      mode: 'pro',
      industry: null,
      inboundToken: null,
      slackWebhookUrl: null,
      teamsWebhookUrl: null,
      chatworkApiToken: null,
      chatworkRoomId: null,
      subscriptionPlan: 'enterprise', // SSO 許可プラン
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      trialEndsAt: null,
      createdAt: new Date(),
    });

    // 有効な SSO 設定を登録する
    await repos.ssoConfigs.upsert({
      tenantId: TENANT_ID,
      enabled: true,
      idpEntityId: IDP_ENTITY_ID,
      idpSsoUrl: 'https://idp.example.com/sso',
      idpX509Cert: certB64,
    });

    // SSO 本人に対応する既存ユーザーをシードする (JIT 無効のため事前登録が必須)
    store.users.set('user-1', {
      id: 'user-1',
      email: USER_EMAIL,
      name: 'エージェント太郎',
      passwordHash: 'x', // SSO ログインでは使わないダミー値
      role: 'agent',
      tenantId: TENANT_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(() => {
    __resetRateLimits();
  });

  it('同一アサーションの2回目のPOSTはリプレイとして拒否する', async () => {
    const samlResponse = makeSignedResponse('_assertion-replay-1');

    // 1 回目: 正当なログインとして受理される (ハンドオフ確認ページの 200 応答)
    const first = await postAcs(samlResponse);
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    expect(firstBody).toContain('SSO ログインの確認');

    // 2 回目: 全く同じ SAMLResponse (同一アサーション ID) を再送するとリプレイとして拒否される
    const second = await postAcs(samlResponse);
    expect(second.status).toBe(303);
    expect(second.headers.get('location')).toContain('error=sso-invalid');
  });

  it('異なるアサーションであればそれぞれ独立して受理される', async () => {
    const first = await postAcs(makeSignedResponse('_assertion-distinct-1'));
    expect(first.status).toBe(200);

    const second = await postAcs(makeSignedResponse('_assertion-distinct-2'));
    expect(second.status).toBe(200);
  });
});
