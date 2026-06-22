'use server';

// Phase 4 Enterprise: SAML SSO 設定を削除する Server Action。
// Enterprise プランの管理者のみ実行可能。削除すると SSO ログインが無効化される。
// docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」。

// Next.js のキャッシュ無効化
import { revalidatePath } from 'next/cache';
// 現在のセッション取得
import { auth } from '@/lib/auth';
// データリポジトリ
import { repos } from '@/data';
// プラン別の SSO 可否ゲート (Enterprise のみ)
import { isSsoAllowed } from '@/lib/plan-guard';

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
  // セッション取得と認証チェック
  const session = await auth();
  // 未ログインまたは tenantId 不在は拒否
  if (!session?.user?.id || !session.user.tenantId) {
    return { error: '認証が必要です' };
  }
  // 管理者以外は不可
  if (session.user.role !== 'admin') {
    return { error: 'この操作は管理者のみ実行できます' };
  }
  // セッション由来の tenantId のみ使う
  const tenantId = session.user.tenantId;

  // テナントを取得してプランを確認する (Enterprise 以外は SSO 機能自体を提供しない)
  const tenant = await repos.tenants.findById(tenantId);
  if (!tenant) return { error: 'テナント情報の取得に失敗しました' };
  if (!isSsoAllowed(tenant.subscriptionPlan)) {
    return { error: 'SSO は Enterprise プランでのみ利用できます。' };
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
