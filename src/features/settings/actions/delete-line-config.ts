'use server';

// Phase 2 フォローアップ: テナント単位の LINE 公式アカウント連携設定を削除する Server Action。
// 自テナントの admin であれば実行可能 (プラン不問)。削除すると LINE Webhook 取り込み・push が
// 無効化される。プラン降格後に既存設定を削除できなくなる不具合を避けるため、削除はプラン非依存の
// 軽量ゲートで検証する (作成/更新の assertLineConfigAdmin とは異なる。line-config-context.ts 参照)。
// docs/smb-dx-pivot-plan.md §4 Phase 2.1。

// Next.js のキャッシュ無効化
import { revalidatePath } from 'next/cache';
// データリポジトリ
import { repos } from '@/data';
// LINE 連携設定削除の共有認可ゲート (ログイン済み・admin・自テナント。プラン不問)
import { assertLineConfigOwner } from '@/lib/line-config-context';
// 連打防止のための共通レート制限ヘルパー
import { checkRateLimit } from '@/lib/rate-limit';

// 削除結果型 (useActionState 互換)
export interface DeleteLineConfigState {
  error?: string; // エラーメッセージ
  success?: boolean; // 成功フラグ
}

// LINE 連携設定を削除するサーバーアクション
export async function deleteLineConfig(
  _prevState: DeleteLineConfigState,
  _formData: FormData,
): Promise<DeleteLineConfigState> {
  // 共有ゲートで「ログイン済み・admin・自テナント」をまとめて検証する (プラン不問)
  const gate = await assertLineConfigOwner();
  // ゲート不通過ならその理由をそのまま返す
  if (!gate.ok) return { error: gate.error };
  // 検証済みの tenantId (セッション由来)
  const tenantId = gate.tenantId;

  // LINE 連携設定の作成・更新・削除の連打を抑制 (60 秒あたり 10 回まで、テナント単位で
  // update-line-config.ts と共有する)
  const rateLimitError = checkRateLimit(`line-config-mutate:${tenantId}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitError) return { error: rateLimitError };

  try {
    // LINE 連携設定を削除する (tenantId スコープ)
    await repos.lineConfigs.delete(tenantId);
    // 設定ページのキャッシュを無効化する
    revalidatePath('/settings');
    // 成功を返す
    return { success: true };
  } catch (err) {
    // 失敗はログに残して汎用メッセージを返す
    console.error('[delete-line-config] LINE 連携設定の削除に失敗しました:', err);
    return { error: 'LINE 連携設定の削除に失敗しました' };
  }
}
