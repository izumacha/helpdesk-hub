'use server';

// フォローアップ (2026-07-21): カテゴリは Location (拠点) と同じ「テナント全体の設定」だが、
// 業種テンプレ初期投入以外に追加・変更・削除の手段が無く、一度テナントを作成すると
// カテゴリ構成が永久に凍結されていた。create-location.ts と同じ設計で CRUD を追加する。
// docs/smb-dx-pivot-plan.md §5.2「多店舗・多拠点対応」フォローアップ (Location と同じ設定系機能)

// データリポジトリ
import { repos } from '@/data';
// 設定ページのキャッシュを無効化するための Next.js キャッシュ関数
import { revalidatePath } from 'next/cache';
// 「ログイン済み・admin・自テナント・Pro モード」を検証する共有ゲート (throw せず {ok,error} を返す契約)
import { assertCategoryManagementAdmin } from '@/lib/category-admin-gate';
// 連打防止のための共通レート制限ヘルパー
import { checkRateLimit } from '@/lib/rate-limit';
// 設定変更監査ログへの記録を共通化するヘルパー
import { recordSettingsAudit } from '@/lib/settings-audit';
// Prisma の一意制約違反 (P2002) 判定の共通ヘルパー (§6 DRY)
import { isUniqueConstraintError } from '@/lib/prisma-errors';

// 作成結果の戻り値型
export interface CreateCategoryResult {
  // 作成されたカテゴリ ID (成功時)
  categoryId?: string;
  // エラーメッセージ (失敗時)
  error?: string;
}

// カテゴリを新規作成するサーバーアクション
export async function createCategory(formData: FormData): Promise<CreateCategoryResult> {
  // 共有ゲートで「ログイン済み・admin・自テナント・Pro モード」をまとめて検証する
  const gate = await assertCategoryManagementAdmin();
  if (!gate.ok) return { error: gate.error };
  const tenantId = gate.tenantId;

  // カテゴリの作成・更新・削除の連打を抑制 (60 秒あたり 10 回まで、テナント単位で共有。
  // create-location.ts と同じ「同一テナントの複数管理者で枠を分けない」方針)
  const rateLimitError = checkRateLimit(`category-mutate:${tenantId}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitError) return { error: rateLimitError };

  // フォームデータから入力値を取り出す
  const name = (formData.get('name') ?? '').toString().trim();

  // カテゴリ名の必須チェック (1〜100 文字)
  if (!name) {
    return { error: 'カテゴリ名は必須です' };
  }
  if (name.length > 100) {
    return { error: 'カテゴリ名は100文字以内で入力してください' };
  }

  try {
    // カテゴリを DB に作成する (tenantId はセッション由来のみを使いクロステナント防止)
    const category = await repos.categories.create({ tenantId, name });
    // 設定ページのキャッシュを無効化して新しいカテゴリがすぐ反映されるようにする
    revalidatePath('/settings');

    // 監査ログに「誰がカテゴリを作成したか」を記録する
    await recordSettingsAudit({
      tenantId,
      actorId: gate.userId,
      action: 'category_create',
      logPrefix: '[create-category]',
    });

    return { categoryId: category.id };
  } catch (err) {
    // カテゴリ名の重複エラーを共通ヘルパーで検出し、ユーザー向けメッセージに変換する
    if (isUniqueConstraintError(err)) {
      return { error: 'このカテゴリ名はすでに使用されています' };
    }
    console.error('[create-category] カテゴリ作成エラー:', err);
    return { error: 'カテゴリの作成に失敗しました' };
  }
}
