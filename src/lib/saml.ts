// Phase 4 Enterprise: SAML SSO の Service Provider (SP) コア。
// docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」。
//
// 役割:
//   - テナントの SSO 設定 (TenantSsoConfig) から SAML SP インスタンスを構築する。
//   - ログイン用の AuthnRequest リダイレクト URL を生成する。
//   - IdP から受け取った SAMLResponse の署名・条件 (Issuer/Audience/期限) を検証し、
//     ログインすべきユーザーのメールアドレスを取り出す。
//   - SP メタデータ XML を生成する。
//
// セキュリティ方針 (CLAUDE.md §9):
//   - 署名検証・XML 正規化などの暗号処理は自前実装せず、実績ある @node-saml/node-saml に委譲する。
//   - wantAssertionsSigned=true でアサーション署名を必須化し、未署名/改竄応答を拒否する (fail-closed)。
//   - Issuer (idpIssuer) と Audience を必ず検証し、別 IdP / 別 SP 宛の応答を受け入れない。
//
// 本モジュールは node-saml (Node 専用ライブラリ) を読み込むため、必ず Node ランタイムの
// ルートハンドラからのみ import すること (Edge ランタイム不可)。

// node-saml の SP 実装
import { SAML } from '@node-saml/node-saml';
// SSO 設定ドメイン型
import type { TenantSsoConfig } from '@/domain/types';

// 受信アサーションの許容時刻ずれ (IdP とのクロック差吸収)。5 分まで許容する
const SAML_CLOCK_SKEW_MS = 5 * 60 * 1000;

// テナントの SSO 用 SP エンドポイント URL 群を組み立てる純粋関数。
// SP の EntityID は ACS とは別の安定した URL (metadata) を使う慣例に従う。
export function buildSpUrls(baseUrl: string, tenantId: string) {
  // 末尾スラッシュを除いた基底 URL (二重スラッシュ防止)
  const base = baseUrl.replace(/\/+$/, '');
  // テナントごとの SSO エンドポイントの接頭辞
  const prefix = `${base}/api/auth/sso/${encodeURIComponent(tenantId)}`;
  // 各 URL を返す
  return {
    entityId: `${prefix}/metadata`, // SP の EntityID (= Audience。メタデータ URL を兼ねる)
    acsUrl: `${prefix}/acs`, // Assertion Consumer Service (IdP が応答を POST する先)
    loginUrl: `${prefix}/login`, // SSO ログイン開始 URL
    metadataUrl: `${prefix}/metadata`, // SP メタデータ URL
  };
}

// PEM 形式の証明書から base64 本体だけを取り出す (node-saml は base64 本体を期待するため正規化)。
// 既に base64 本体だけが渡された場合はヘッダが無いのでそのまま空白除去して返す。
function normalizeCert(cert: string): string {
  // BEGIN/END CERTIFICATE 行を除去し、すべての空白 (改行含む) を取り除く
  return cert
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '')
    .trim();
}

// SSO 設定が SAML インスタンス構築に必要な値を満たしているか検証する (満たさなければ throw)。
function assertConfigComplete(config: TenantSsoConfig): void {
  // IdP の EntityID (Issuer 検証に必須)
  if (!config.idpEntityId.trim()) throw new Error('SSO 設定の IdP EntityID が未設定です。');
  // IdP の SSO エンドポイント (AuthnRequest 送信先に必須)
  if (!config.idpSsoUrl.trim()) throw new Error('SSO 設定の IdP SSO URL が未設定です。');
  // 署名検証用の証明書 (これが無いと検証できない = fail-closed)
  if (!normalizeCert(config.idpX509Cert)) throw new Error('SSO 設定の IdP 証明書が未設定です。');
}

// テナントの SSO 設定 + 基底 URL から node-saml の SP インスタンスを構築する。
// 設定不備があれば例外を投げる (呼び出し側で 4xx/5xx に変換する)。
export function createSamlInstance(config: TenantSsoConfig, baseUrl: string, tenantId: string): SAML {
  // 設定の完全性を確認する (不備なら throw)
  assertConfigComplete(config);
  // SP の各 URL を組み立てる
  const sp = buildSpUrls(baseUrl, tenantId);
  // node-saml の SP インスタンスを生成して返す
  return new SAML({
    // IdP の署名検証用証明書 (base64 本体に正規化して渡す)
    idpCert: normalizeCert(config.idpX509Cert),
    // SP の EntityID (AuthnRequest の Issuer・メタデータの entityID に使われる)
    issuer: sp.entityId,
    // IdP が SAMLResponse を POST してくる先 (ACS)。Destination 検証にも使われる
    callbackUrl: sp.acsUrl,
    // IdP の SSO エンドポイント (AuthnRequest のリダイレクト先)
    entryPoint: config.idpSsoUrl,
    // 受信アサーションの Issuer がこの値と一致することを必須化する (別 IdP 応答を拒否)
    idpIssuer: config.idpEntityId,
    // Audience を SP の EntityID に固定する (別 SP 宛の応答を拒否)
    audience: sp.entityId,
    // アサーション署名を必須化する (未署名/改竄応答を拒否 = fail-closed)
    wantAssertionsSigned: true,
    // Response 全体の署名は任意 (アサーション署名のみの IdP が多いため必須にしない)
    wantAuthnResponseSigned: false,
    // クロックずれの許容範囲 (期限検証の厳しすぎる失敗を防ぐ)
    acceptedClockSkewMs: SAML_CLOCK_SKEW_MS,
    // 署名アルゴリズムは SHA-256 を既定にする (SHA-1 を避ける)
    signatureAlgorithm: 'sha256',
    // SP からの AuthnRequest には署名しない (IdP 側で SP 署名を要求しない一般的構成)
    // 署名鍵をアプリに持たせない分、構成が単純で運用しやすい
  });
}

// SSO ログイン開始用の IdP リダイレクト URL を生成する。
// relayState には認証後に戻したいアプリ内パス等を載せられる (本実装では未使用なら空文字)。
export async function getSsoLoginUrl(saml: SAML, relayState = ''): Promise<string> {
  // node-saml に AuthnRequest を生成させ、IdP へのリダイレクト URL を得る
  return saml.getAuthorizeUrlAsync(relayState, undefined, {});
}

// 検証成功時に呼び出し側へ返す最小限の本人情報
export interface SamlIdentity {
  email: string; // ログインすべきユーザーのメールアドレス (小文字正規化済み)
  nameId: string; // IdP が発行した NameID (監査・突き合わせ用)
}

// SAMLResponse (base64) を検証し、本人のメールアドレスを取り出す。
// 署名不正・Audience 不一致・期限切れ等は node-saml が例外を投げる (= ログイン拒否)。
// expectedIssuer には設定の IdP EntityID を渡し、アサーションの Issuer 一致を多層防御として検証する
// (node-saml は login 経路で idpIssuer を強制しないため、ここで明示的に確認する)。
export async function validateSamlResponse(
  saml: SAML,
  samlResponseB64: string,
  expectedIssuer: string,
): Promise<SamlIdentity> {
  // POST バインディングの SAMLResponse を検証する。失敗時は例外が投げられる
  const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponseB64 });
  // プロファイルが取れない (LogoutResponse 等) 場合は本人特定できないので拒否する
  if (!profile) throw new Error('SAML レスポンスから本人情報を取得できませんでした。');

  // 多層防御: アサーションの Issuer が設定の IdP EntityID と一致することを必須化する。
  // 署名検証 (configured idpCert) が一次防御だが、Issuer 文字列も突き合わせて別 IdP を拒否する。
  const actualIssuer = typeof profile.issuer === 'string' ? profile.issuer : '';
  if (actualIssuer !== expectedIssuer) {
    throw new Error('SAML レスポンスの Issuer が設定の IdP と一致しません。');
  }

  // メールアドレスを決定する: NameID が email 形式ならそれを使い、
  // そうでなければ一般的なメール属性 (email / mail) を参照する。
  const nameId = typeof profile.nameID === 'string' ? profile.nameID : '';
  // 属性からメール候補を取り出す (IdP により属性名が異なるため複数試す)
  const attrEmail =
    pickStringAttr(profile, 'email') ??
    pickStringAttr(profile, 'mail') ??
    pickStringAttr(profile, 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress');
  // NameID が email 形式ならそれを優先、無ければ属性のメールを使う
  const rawEmail = nameId.includes('@') ? nameId : (attrEmail ?? '');
  // メールが取れなければ本人特定できないので拒否する (fail-closed)
  const email = rawEmail.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw new Error('SAML レスポンスにメールアドレスが含まれていません。');
  }
  // 本人情報を返す
  return { email, nameId: nameId || email };
}

// SAML プロファイルから文字列属性を 1 つ取り出すヘルパー (配列なら先頭、無ければ undefined)。
function pickStringAttr(profile: Record<string, unknown>, key: string): string | undefined {
  // 指定キーの値を取り出す
  const value = profile[key];
  // 文字列ならそのまま返す
  if (typeof value === 'string') return value;
  // 配列なら先頭の文字列要素を返す
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  // それ以外は undefined
  return undefined;
}

// SP メタデータ XML を生成する純粋関数 (IdP 側に登録するための EntityDescriptor)。
// IdP 証明書が未設定の段階でも SP メタデータは提示できる必要がある (管理者が IdP を構成する
// ために先に SP メタデータを使うため)。よって node-saml の SP インスタンスに依存せず、
// 秘密情報を含まない SP の URL 群だけから XML を組み立てる。
export function buildSpMetadataXml(baseUrl: string, tenantId: string): string {
  // SP の EntityID / ACS URL を組み立てる
  const sp = buildSpUrls(baseUrl, tenantId);
  // XML 属性に値を埋め込む前に最小限のエスケープを行う (URL 由来の特殊文字対策)
  const entityId = escapeXmlAttr(sp.entityId);
  const acsUrl = escapeXmlAttr(sp.acsUrl);
  // SAML 2.0 の SPSSODescriptor を含むメタデータ XML を返す。
  // AuthnRequestsSigned=false (SP 署名なし) / WantAssertionsSigned=true (アサーション署名必須)。
  return `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acsUrl}" index="0" isDefault="true"/>
  </SPSSODescriptor>
</EntityDescriptor>`;
}

// XML 属性値に安全に埋め込むための最小エスケープ (& < > " ' を実体参照へ変換)。
function escapeXmlAttr(value: string): string {
  // 各特殊文字を XML 実体参照に置換して返す
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
