'use server';

// Phase 4 Enterprise: SAML SSO 設定を作成/更新する Server Action。
// Enterprise プランの管理者のみ実行可能。docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」。

// Next.js のキャッシュ無効化 (設定ページの再レンダリングに使う)
import { revalidatePath } from 'next/cache';
// Node の X.509 証明書パーサ (証明書の妥当性検証に使う)
import { X509Certificate } from 'node:crypto';
// 現在のセッション取得
import { auth } from '@/lib/auth';
// データリポジトリ (テナント取得・SSO 設定 upsert)
import { repos } from '@/data';
// プラン別の SSO 可否ゲート (Enterprise のみ)
import { isSsoAllowed } from '@/lib/plan-guard';

// 入力長の上限 (DoS・異常入力対策。EntityID/URL は十分長め、証明書は数 KB を想定)
const ENTITY_ID_MAX = 1024; // IdP EntityID の最大長
const SSO_URL_MAX = 2048; // IdP SSO URL の最大長
const CERT_MAX = 16384; // 証明書 (PEM/base64) の最大長

// PEM 形式の証明書から base64 本体だけを取り出す (保存形式に正規化する)
function normalizeCert(cert: string): string {
  // BEGIN/END 行と空白を除去する
  return cert
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '')
    .trim();
}

// base64 本体を PEM にラップして X509Certificate でパースできるか検証する。
// パースできれば正規化済み base64 を返し、できなければ null を返す。
function validateCert(rawCert: string): string | null {
  // base64 本体に正規化する
  const b64 = normalizeCert(rawCert);
  // 空または長すぎる場合は不正
  if (!b64 || b64.length > CERT_MAX) return null;
  // base64 として妥当な文字種かを確認する (不正文字混入を弾く)
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
  // PEM にラップして X509 としてパースを試みる
  try {
    // 64 文字ごとに改行を入れて標準的な PEM を組み立てる
    const pem = `-----BEGIN CERTIFICATE-----\n${b64.replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
    // パースに成功すれば妥当な証明書 (例外なら不正)
    new X509Certificate(pem);
    // 正規化済み base64 を返す
    return b64;
  } catch {
    // パース失敗は不正な証明書
    return null;
  }
}

// SSO 設定の更新結果型 (useActionState 互換)
export interface UpdateSsoConfigState {
  error?: string; // エラーメッセージ
  success?: boolean; // 成功フラグ
}

// SSO 設定を作成/更新するサーバーアクション (useActionState 互換シグネチャ)
export async function updateSsoConfig(
  _prevState: UpdateSsoConfigState,
  formData: FormData,
): Promise<UpdateSsoConfigState> {
  // セッション取得と認証チェック
  const session = await auth();
  // 未ログインまたは tenantId 不在は拒否
  if (!session?.user?.id || !session.user.tenantId) {
    return { error: '認証が必要です' };
  }
  // 管理者以外は設定変更不可 (UI 非表示に頼らずサーバー側で強制)
  if (session.user.role !== 'admin') {
    return { error: 'この操作は管理者のみ実行できます' };
  }
  // セッション由来の tenantId のみ使う (クロステナント設定防止)
  const tenantId = session.user.tenantId;

  // テナントを取得してプランが SSO を許可するか確認する (Enterprise のみ)
  const tenant = await repos.tenants.findById(tenantId);
  if (!tenant) return { error: 'テナント情報の取得に失敗しました' };
  if (!isSsoAllowed(tenant.subscriptionPlan)) {
    return { error: 'SSO は Enterprise プランでのみ利用できます。' };
  }

  // フォームから各値を取り出して前後空白を除去する
  const idpEntityId = String(formData.get('idpEntityId') ?? '').trim();
  const idpSsoUrl = String(formData.get('idpSsoUrl') ?? '').trim();
  const idpX509CertRaw = String(formData.get('idpX509Cert') ?? '');
  // 有効化チェックボックス (チェック時のみ 'on' が送られる)
  const enabled = formData.get('enabled') === 'on';

  // IdP EntityID の検証 (必須・長さ上限)
  if (!idpEntityId) return { error: 'IdP の EntityID は必須です' };
  if (idpEntityId.length > ENTITY_ID_MAX) return { error: 'IdP の EntityID が長すぎます' };

  // IdP SSO URL の検証 (必須・https・URL 形式・長さ上限)
  if (!idpSsoUrl) return { error: 'IdP の SSO URL は必須です' };
  if (idpSsoUrl.length > SSO_URL_MAX) return { error: 'IdP の SSO URL が長すぎます' };
  // https:// で始まる正しい URL であることを確認する (ブラウザのリダイレクト先になるため)
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(idpSsoUrl);
  } catch {
    return { error: 'IdP の SSO URL の形式が正しくありません' };
  }
  // https 以外のスキームは拒否する (平文 http やカスタムスキームを許さない)
  if (parsedUrl.protocol !== 'https:') {
    return { error: 'IdP の SSO URL は https:// で始まる必要があります' };
  }

  // 証明書の検証 (X509 としてパースできること)
  const cert = validateCert(idpX509CertRaw);
  if (!cert) {
    return { error: 'IdP の X.509 証明書が正しくありません (PEM または base64 本体を貼り付けてください)' };
  }

  try {
    // SSO 設定を upsert する (tenantId スコープで他テナントに影響しない)
    await repos.ssoConfigs.upsert({
      tenantId,
      enabled,
      idpEntityId,
      idpSsoUrl,
      idpX509Cert: cert,
    });
    // 設定ページのキャッシュを無効化して結果をすぐ反映する
    revalidatePath('/settings');
    // 成功を返す
    return { success: true };
  } catch (err) {
    // 失敗はログに残して汎用メッセージを返す (内部詳細を漏らさない)
    console.error('[update-sso-config] SSO 設定の保存に失敗しました:', err);
    return { error: 'SSO 設定の保存に失敗しました' };
  }
}
