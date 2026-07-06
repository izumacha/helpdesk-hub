'use server';

// Phase 2 フォローアップ: テナント単位の LINE 公式アカウント連携設定を削除する Server Action。
// Pro / Enterprise プランの管理者のみ実行可能。削除すると LINE Webhook 取り込み・push が無効化される。
// docs/smb-dx-pivot-plan.md §4 Phase 2.1。

// Next.js のキャッシュ無効化
import { revalidatePath } from 'next/cache';
// データリポジトリ
import { repos } from '@/data';
// LINE 連携設定変更の共有認可ゲート (ログイン済み・admin・Pro/Enterprise)
import { assertLineConfigAdmin } from '@/lib/line-config-context';

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
  // 共有ゲートで「ログイン済み・admin・Pro/Enterprise」をまとめて検証する
  const gate = await assertLineConfigAdmin();
  // ゲート不通過ならその理由をそのまま返す
  if (!gate.ok) return { error: gate.error };
  // 検証済みの tenantId (セッション由来)
  const tenantId = gate.tenantId;

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
