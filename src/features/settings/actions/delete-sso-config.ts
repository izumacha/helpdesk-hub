'use server';

// Phase 4 Enterprise: SAML SSO 設定を削除する Server Action。
// 自テナントの admin であれば実行可能 (プラン不問)。削除すると SSO ログインが無効化される。
// プラン降格後に既存設定を削除できなくなる不具合を避けるため、削除はプラン非依存の軽量ゲートで
// 検証する (作成/更新の assertSsoConfigAdmin とは異なる。sso-context.ts 参照)。
// docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」。

// Next.js のキャッシュ無効化
import { revalidatePath } from 'next/cache';
// データリポジトリ
import { repos } from '@/data';
// SSO 設定削除の共有認可ゲート (ログイン済み・admin・自テナント。プラン不問)
import { assertSsoConfigOwner } from '@/lib/sso-context';
// 連打防止のための共通レート制限ヘルパー
import { enforceRateLimit } from '@/lib/rate-limit';

// 削除結果型 (useActionState 互換)
export interface DeleteSsoConfigState {
  error?: string; // エラーメッセージ
  success?: boolean; // 成功フラグ
}

// SSO 設定を削除するサーバーアクション
export async function deleteSsoConfig(
  _prevState: DeleteSsoConfigState,
  _formData: FormData,
): Promise<DeleteSsoConfigState> {
  // 共有ゲートで「ログイン済み・admin・自テナント」をまとめて検証する (プラン不問)
  const gate = await assertSsoConfigOwner();
  // ゲート不通過ならその理由をそのまま返す
  if (!gate.ok) return { error: gate.error };
  // 検証済みの tenantId (セッション由来)
  const tenantId = gate.tenantId;

  try {
    // SSO 設定の作成・更新・削除の連打を抑制 (60 秒あたり 10 回まで、テナント単位で
    // update-sso-config.ts と共有する)
    enforceRateLimit(`sso-config-mutate:${tenantId}`, { limit: 10, windowMs: 60_000 });
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'しばらく時間をおいて再度お試しください' };
  }

  try {
    // SSO 設定を削除する (tenantId スコープ)
    await repos.ssoConfigs.delete(tenantId);
    // 設定ページのキャッシュを無効化する
    revalidatePath('/settings');
    // 成功を返す
    return { success: true };
  } catch (err) {
    // 失敗はログに残して汎用メッセージを返す
    console.error('[delete-sso-config] SSO 設定の削除に失敗しました:', err);
    return { error: 'SSO 設定の削除に失敗しました' };
  }
}
