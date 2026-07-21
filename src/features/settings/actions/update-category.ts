'use server';

// フォローアップ (2026-07-21): カテゴリ名を変更する手段が無かったギャップの解消。
// update-location.ts と同じ CAS (compare-and-swap) 設計で TOCTOU を防ぐ。

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
// Prisma の一意制約違反 (P2002) 判定の共通ヘルパー (§6 DRY)
import { isUniqueConstraintError } from '@/lib/prisma-errors';

// 更新結果の戻り値型
export interface UpdateCategoryResult {
  // 成功フラグ (成功時に true)
  success?: boolean;
  // エラーメッセージ (失敗時)
  error?: string;
}

// カテゴリ名を更新するサーバーアクション
export async function updateCategory(
  categoryId: string,
  formData: FormData,
): Promise<UpdateCategoryResult> {
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

  // 更新後の名前を取り出す
  const name = (formData.get('name') ?? '').toString().trim();

  if (!name) {
    return { error: 'カテゴリ名は必須です' };
  }
  if (name.length > 100) {
    return { error: 'カテゴリ名は100文字以内で入力してください' };
  }

  // 編集フォームは常に現在値を defaultValue で事前入力して丸ごと再送信する構成のため、
  // 読み取り時点の値を expected として渡し、書き込み直前にも現在値が変わっていないことを
  // 保証する CAS にする (update-location.ts と同じ設計)。
  const existing = await repos.categories.findById(categoryId, tenantId);

  try {
    const updated = await repos.categories.update(
      categoryId,
      tenantId,
      { name },
      existing ? { name: existing.name } : undefined,
    );
    if (!updated) {
      // 競合時もフォームの表示を最新化できるよう再レンダリングしておく
      revalidatePath('/settings');
      return {
        error: '他の管理者による変更と競合しました。最新の設定を確認してから再度お試しください。',
      };
    }
    revalidatePath('/settings');

    // 監査ログに「誰がカテゴリを更新したか」を記録する
    await recordSettingsAudit({
      tenantId,
      actorId: gate.userId,
      action: 'category_update',
      logPrefix: '[update-category]',
    });

    return { success: true };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { error: 'このカテゴリ名はすでに使用されています' };
    }
    const message = err instanceof Error ? err.message : '';
    if (message.includes('not found')) {
      return { error: 'カテゴリが見つかりません' };
    }
    console.error('[update-category] カテゴリ更新エラー:', err);
    return { error: 'カテゴリの更新に失敗しました' };
  }
}
