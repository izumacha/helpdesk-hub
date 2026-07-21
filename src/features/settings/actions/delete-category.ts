'use server';

// フォローアップ (2026-07-21): カテゴリを削除する手段が無かったギャップの解消。
// delete-location.ts と同じ設計 (削除すると紐づくチケットの categoryId は SetNull で null に戻る)。

// データリポジトリ
import { repos } from '@/data';
// 設定ページのキャッシュを無効化するための Next.js キャッシュ関数
import { revalidatePath } from 'next/cache';
// 「ログイン済み・admin・自テナント」を検証する共有ゲート (throw せず {ok,error} を返す契約)
import { assertTenantAdmin } from '@/lib/tenant-admin-gate';
// 連打防止のための共通レート制限ヘルパー
import { checkRateLimit } from '@/lib/rate-limit';
// 設定変更監査ログへの記録を共通化するヘルパー
import { recordSettingsAudit } from '@/lib/settings-audit';

// 削除結果の戻り値型
export interface DeleteCategoryResult {
  // 成功フラグ (成功時に true)
  success?: boolean;
  // エラーメッセージ (失敗時)
  error?: string;
}

// カテゴリを削除するサーバーアクション (紐づくチケットの categoryId は SetNull)
export async function deleteCategory(categoryId: string): Promise<DeleteCategoryResult> {
  // 共有ゲートで「ログイン済み・admin・自テナント」をまとめて検証する
  const gate = await assertTenantAdmin();
  if (!gate.ok) return { error: gate.error };
  const tenantId = gate.tenantId;

  // カテゴリの作成・更新・削除の連打を抑制 (create-category.ts と同じテナント単位の共有枠)
  const rateLimitError = checkRateLimit(`category-mutate:${tenantId}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitError) return { error: rateLimitError };

  try {
    // tenantId をスコープに含めて削除 (他テナントのカテゴリを削除できないよう保護)
    await repos.categories.delete(categoryId, tenantId);
    revalidatePath('/settings');

    // 監査ログに「誰がカテゴリを削除したか」を記録する
    await recordSettingsAudit({
      tenantId,
      actorId: gate.userId,
      action: 'category_delete',
      logPrefix: '[delete-category]',
    });

    return { success: true };
  } catch (err) {
    console.error('[delete-category] カテゴリ削除エラー:', err);
    return { error: 'カテゴリの削除に失敗しました' };
  }
}
