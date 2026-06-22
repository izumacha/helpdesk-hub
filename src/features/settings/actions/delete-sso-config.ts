'use server';

// Phase 4 Enterprise: SAML SSO 設定を削除する Server Action。
// Enterprise プランの管理者のみ実行可能。削除すると SSO ログインが無効化される。
// docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」。

// Next.js のキャッシュ無効化
import { revalidatePath } from 'next/cache';
// データリポジトリ
import { repos } from '@/data';
// SSO 設定変更の共有認可ゲート (ログイン済み・admin・Enterprise)
import { assertSsoConfigAdmin } from '@/lib/sso-context';

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
  // 共有ゲートで「ログイン済み・admin・Enterprise」をまとめて検証する
  const gate = await assertSsoConfigAdmin();
  // ゲート不通過ならその理由をそのまま返す
  if (!gate.ok) return { error: gate.error };
  // 検証済みの tenantId (セッション由来)
  const tenantId = gate.tenantId;

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
