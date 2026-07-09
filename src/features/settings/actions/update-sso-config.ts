'use server';

// Phase 4 Enterprise: SAML SSO 設定を作成/更新する Server Action。
// Enterprise プランの管理者のみ実行可能。docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」。

// Next.js のキャッシュ無効化 (設定ページの再レンダリングに使う)
import { revalidatePath } from 'next/cache';
// Node の X.509 証明書パーサ (証明書の妥当性検証に使う)
import { X509Certificate } from 'node:crypto';
// データリポジトリ (SSO 設定 upsert)
import { repos } from '@/data';
// SSO 設定変更の共有認可ゲート (ログイン済み・admin・Enterprise)
import { assertSsoConfigAdmin } from '@/lib/sso-context';
// 証明書の base64 正規化 (SAML SP コアと共有する純粋ヘルパー)
import { normalizeCert } from '@/lib/saml-cert';
// 連打防止のための共通レート制限ヘルパー
import { checkRateLimit } from '@/lib/rate-limit';

// 入力長の上限 (DoS・異常入力対策。EntityID/URL は十分長め、証明書は数 KB を想定)
const ENTITY_ID_MAX = 1024; // IdP EntityID の最大長
const SSO_URL_MAX = 2048; // IdP SSO URL の最大長
const CERT_MAX = 16384; // 証明書 (PEM/base64) の最大長

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
    // 64 文字ごとに改行を入れて標準的な PEM を組み立てる。
    // b64.length が 64 の倍数のとき /(.{64})/g は最後のチャンクの後ろにも改行を挿入するため、
    // 末尾の余分な改行を trim してから END 行を続けないと、END 行の直前に空行が入った
    // 不正な PEM になり X509Certificate が正当な証明書でも「wrong tag」で拒否してしまう
    // (証明書の base64 長がたまたま 64 の倍数になるだけの入力が誤って弾かれるバグだった)
    const wrapped = b64.replace(/(.{64})/g, '$1\n').replace(/\n+$/, '');
    const pem = `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----\n`;
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
  // 共有ゲートで「ログイン済み・admin・Enterprise」をまとめて検証する
  const gate = await assertSsoConfigAdmin();
  // ゲート不通過ならその理由をそのまま返す
  if (!gate.ok) return { error: gate.error };
  // 検証済みの tenantId (セッション由来)
  const tenantId = gate.tenantId;

  // SSO 設定の作成・更新・削除の連打を抑制 (60 秒あたり 10 回まで、テナント単位で
  // delete-sso-config.ts と共有する)。update/delete で同じキーを共有する理由も
  // create/update/delete-location.ts と同じ (アクション別に分けると実質の上限が
  // action 数倍になってしまう)
  const rateLimitError = checkRateLimit(`sso-config-mutate:${tenantId}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitError) return { error: rateLimitError };

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
    return {
      error: 'IdP の X.509 証明書が正しくありません (PEM または base64 本体を貼り付けてください)',
    };
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
