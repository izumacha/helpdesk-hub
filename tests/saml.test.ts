// Vitest のテスト DSL
import { beforeAll, describe, expect, it } from 'vitest';
// 子プロセスで openssl を呼ぶ (テスト用の使い捨て鍵/証明書を生成する)
import { execFileSync } from 'node:child_process';
// 一時ディレクトリ・ファイル操作
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// XML 署名 (テスト内で IdP の署名付き応答を作るために使用。node-saml の依存に含まれる)
import { SignedXml } from 'xml-crypto';

// テスト対象: SAML SP コア
import {
  buildSpUrls,
  buildSpMetadataXml,
  createSamlInstance,
  validateSamlResponse,
} from '../src/lib/saml';
// プラン別 SSO ゲート (Enterprise のみ許可)
import { isSsoAllowed } from '../src/lib/plan-guard';
// SSO 設定ドメイン型
import type { TenantSsoConfig } from '../src/domain/types';

// テストで使う固定値
const BASE_URL = 'https://app.example.com';
const TENANT_ID = 't-test';
const IDP_ENTITY_ID = 'https://idp.example.com/entity';
// SP の URL 群 (Audience / Destination の期待値に使う)
const SP = buildSpUrls(BASE_URL, TENANT_ID);

// openssl が使えるかを判定する (使えない環境では署名付きテストをスキップする)
function opensslAvailable(): boolean {
  try {
    // バージョン表示が通れば利用可能
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// テスト用の鍵・証明書 (beforeAll で生成)
let privateKey = '';
let certPem = '';
let certB64 = '';
// 別 IdP を模した 2 つめの証明書 (署名鍵が異なるため検証失敗を確認するのに使う)
let otherCertB64 = '';
const hasOpenssl = opensslAvailable();

// openssl で RSA 鍵 + 自己署名証明書を 1 組生成し PEM とプロパティを返す
function generateKeyPair(): { key: string; certPem: string; certB64: string } {
  // 一時ディレクトリに鍵と証明書を作る
  const dir = mkdtempSync(join(tmpdir(), 'saml-test-'));
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
    // 生成物を読み込む
    const key = readFileSync(join(dir, 'k.pem'), 'utf8');
    const pem = readFileSync(join(dir, 'c.pem'), 'utf8');
    // 証明書の base64 本体 (設定に格納する形式) を作る
    const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    return { key, certPem: pem, certB64: b64 };
  } finally {
    // 一時ディレクトリを掃除する
    rmSync(dir, { recursive: true, force: true });
  }
}

// 署名付き SAML Response を組み立てるオプション
interface ResponseOptions {
  email?: string; // NameID に入れるメール
  audience?: string; // Audience (既定は SP EntityID)
  issuer?: string; // Issuer (既定は IdP EntityID)
  notOnOrAfter?: string; // 条件の失効時刻 ISO 文字列 (既定は 5 分後)
  tamperAfterSign?: boolean; // 署名後に本文を改竄するか
}

// 指定オプションで署名付き SAML Response を生成し base64 で返す純粋ヘルパー
function makeSignedResponse(opts: ResponseOptions = {}): string {
  // 各値の既定を埋める
  const email = opts.email ?? 'user@example.com';
  const audience = opts.audience ?? SP.entityId;
  const issuer = opts.issuer ?? IDP_ENTITY_ID;
  const now = Date.now();
  const issueInstant = new Date(now).toISOString();
  const notOnOrAfter = opts.notOnOrAfter ?? new Date(now + 5 * 60 * 1000).toISOString();
  // Assertion 本体 (Subject/Conditions/AuthnStatement を含む)
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0" IssueInstant="${issueInstant}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData Recipient="${SP.acsUrl}" NotOnOrAfter="${notOnOrAfter}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${issueInstant}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${issueInstant}"><saml:AuthnContext>` +
    `<saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef>` +
    `</saml:AuthnContext></saml:AuthnStatement></saml:Assertion>`;
  // Response でラップする
  const responseXml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r1" Version="2.0" IssueInstant="${issueInstant}" Destination="${SP.acsUrl}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `${assertion}</samlp:Response>`;
  // Assertion 要素に enveloped 署名を付与する
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
  // 署名は Assertion の Issuer の直後に挿入する
  sig.computeSignature(responseXml, {
    location: {
      reference: `//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']`,
      action: 'after',
    },
  });
  let signed = sig.getSignedXml();
  // 署名後に本文を改竄する (署名検証が失敗することを確認するため)
  if (opts.tamperAfterSign) {
    signed = signed.replace(email, 'attacker@evil.com');
  }
  // base64 にして返す (POST バインディングの SAMLResponse 形式)
  return Buffer.from(signed).toString('base64');
}

// テスト用の SSO 設定を組み立てるヘルパー
function makeConfig(overrides: Partial<TenantSsoConfig> = {}): TenantSsoConfig {
  return {
    id: 'cfg1',
    tenantId: TENANT_ID,
    enabled: true,
    idpEntityId: IDP_ENTITY_ID,
    idpSsoUrl: 'https://idp.example.com/sso',
    idpX509Cert: certB64,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// テスト開始前に使い捨て鍵/証明書を 2 組生成する (本物の IdP と別 IdP)
beforeAll(() => {
  // openssl が無ければスキップ (署名付きテストは下で個別に skip 判定)
  if (!hasOpenssl) return;
  // 1 組目: 設定に登録する正規の IdP 証明書
  const primary = generateKeyPair();
  privateKey = primary.key;
  certPem = primary.certPem;
  certB64 = primary.certB64;
  // 2 組目: 署名鍵が異なる別証明書 (証明書不一致の検証に使う)
  otherCertB64 = generateKeyPair().certB64;
});

// プランゲート (純粋・openssl 不要)
describe('SSO プランゲート', () => {
  // Enterprise のみ SSO を許可する
  it('isSsoAllowed は Enterprise のみ true', () => {
    expect(isSsoAllowed('enterprise')).toBe(true); // Enterprise 可
    expect(isSsoAllowed('pro')).toBe(false); // Pro 不可
    expect(isSsoAllowed('free')).toBe(false); // Free 不可
  });
});

// SP メタデータ (純粋・openssl 不要)
describe('SP メタデータ生成', () => {
  // entityID と ACS URL が含まれること
  it('EntityDescriptor に EntityID と ACS URL を含む', () => {
    const xml = buildSpMetadataXml(BASE_URL, TENANT_ID);
    expect(xml).toContain(`entityID="${SP.entityId}"`); // SP の EntityID
    expect(xml).toContain(SP.acsUrl); // ACS の Location
    expect(xml).toContain('WantAssertionsSigned="true"'); // アサーション署名必須を宣言
  });
});

// 署名検証 (openssl が必要なので無い環境ではスキップ)
describe.skipIf(!hasOpenssl)('SAML アサーション検証', () => {
  // 正常系: 正しく署名された応答から本人メールを取り出せる
  it('正しい署名・Issuer・Audience の応答を受理しメールを取り出す', async () => {
    const saml = createSamlInstance(makeConfig(), BASE_URL, TENANT_ID);
    const identity = await validateSamlResponse(saml, makeSignedResponse(), IDP_ENTITY_ID);
    expect(identity.email).toBe('user@example.com'); // 検証済みメール
  });

  // メールは小文字化される
  it('メールアドレスを小文字に正規化する', async () => {
    const saml = createSamlInstance(makeConfig(), BASE_URL, TENANT_ID);
    const identity = await validateSamlResponse(
      saml,
      makeSignedResponse({ email: 'User@Example.com' }),
      IDP_ENTITY_ID,
    );
    expect(identity.email).toBe('user@example.com'); // 小文字化
  });

  // リプレイ防止 (§9) の一意キーとして、アサーション XML の ID 属性を取り出せる
  it('アサーション ID (リプレイ防止の一意キー) を取り出す', async () => {
    const saml = createSamlInstance(makeConfig(), BASE_URL, TENANT_ID);
    // makeSignedResponse の Assertion タグは常に ID="_a1" で組み立てている
    const identity = await validateSamlResponse(saml, makeSignedResponse(), IDP_ENTITY_ID);
    expect(identity.assertionId).toBe('_a1');
  });

  // 異常系: 署名後に本文を改竄すると拒否される
  it('署名後に改竄された応答を拒否する', async () => {
    const saml = createSamlInstance(makeConfig(), BASE_URL, TENANT_ID);
    await expect(
      validateSamlResponse(saml, makeSignedResponse({ tamperAfterSign: true }), IDP_ENTITY_ID),
    ).rejects.toThrow();
  });

  // 異常系: Audience が別 SP 宛だと拒否される
  it('Audience が一致しない応答を拒否する (別 SP 宛)', async () => {
    const saml = createSamlInstance(makeConfig(), BASE_URL, TENANT_ID);
    await expect(
      validateSamlResponse(
        saml,
        makeSignedResponse({ audience: 'https://other-sp.example.com' }),
        IDP_ENTITY_ID,
      ),
    ).rejects.toThrow();
  });

  // 異常系: Issuer が設定の IdP と異なると拒否される (別 IdP のなりすまし)
  it('Issuer が設定の IdP と異なる応答を拒否する', async () => {
    const saml = createSamlInstance(makeConfig(), BASE_URL, TENANT_ID);
    await expect(
      validateSamlResponse(
        saml,
        makeSignedResponse({ issuer: 'https://evil-idp.example.com' }),
        IDP_ENTITY_ID,
      ),
    ).rejects.toThrow();
  });

  // 異常系: 期限切れ (NotOnOrAfter が過去) の応答を拒否する
  it('期限切れの応答を拒否する', async () => {
    const saml = createSamlInstance(makeConfig(), BASE_URL, TENANT_ID);
    // 10 分前に失効した条件を持つ応答を作る
    const expired = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await expect(
      validateSamlResponse(saml, makeSignedResponse({ notOnOrAfter: expired }), IDP_ENTITY_ID),
    ).rejects.toThrow();
  });

  // 異常系: 別の鍵で署名された (証明書が一致しない) 応答を拒否する
  it('設定の証明書と一致しない署名を拒否する', async () => {
    // idpX509Cert を「別 IdP の証明書 (署名鍵が異なる)」に差し替える。
    // 応答は正規の鍵 (key1) で署名されているため、別証明書の公開鍵では検証に失敗する。
    const wrongConfig = makeConfig({ idpX509Cert: otherCertB64 });
    const saml = createSamlInstance(wrongConfig, BASE_URL, TENANT_ID);
    await expect(validateSamlResponse(saml, makeSignedResponse(), IDP_ENTITY_ID)).rejects.toThrow();
  });
});

// 設定不備のガード (純粋・openssl 不要だが証明書が要るものは skip)
describe('SSO 設定の不備ガード', () => {
  // 証明書が空の設定は SAML 構築時に弾かれる
  it('証明書が空の設定は createSamlInstance が例外を投げる', () => {
    expect(() =>
      createSamlInstance(makeConfig({ idpX509Cert: '   ' }), BASE_URL, TENANT_ID),
    ).toThrow();
  });
  // IdP SSO URL が空の設定も弾かれる
  it('IdP SSO URL が空の設定は例外を投げる', () => {
    expect(() => createSamlInstance(makeConfig({ idpSsoUrl: '' }), BASE_URL, TENANT_ID)).toThrow();
  });
});
