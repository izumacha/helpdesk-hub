'use server';

// Phase 4 多拠点: 既存の拠点情報を更新する Server Action。
// 管理者のみが拠点を編集できる。
// docs/smb-dx-pivot-plan.md §5.2「多店舗・多拠点対応」

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
// Prisma の一意制約違反 (P2002) 判定の共通ヘルパー (6 箇所に重複していた判定を一元化 / §6 DRY)
import { isUniqueConstraintError } from '@/lib/prisma-errors';

// 更新結果の戻り値型
export interface UpdateLocationResult {
  // 成功フラグ (成功時に true)
  success?: boolean;
  // エラーメッセージ (失敗時)
  error?: string;
}

// 拠点情報を更新するサーバーアクション
export async function updateLocation(
  locationId: string,
  formData: FormData,
): Promise<UpdateLocationResult> {
  // 共有ゲートで「ログイン済み・admin・自テナント」をまとめて検証する
  const gate = await assertTenantAdmin();
  // ゲート不通過ならその理由をそのまま返す
  if (!gate.ok) return { error: gate.error };
  // 検証済みの tenantId (セッション由来)
  const tenantId = gate.tenantId;

  // 拠点の作成・更新・削除の連打を抑制 (60 秒あたり 10 回まで、テナント単位・
  // create/update/delete で共有。create-location.ts のコメント参照)
  const rateLimitError = checkRateLimit(`location-mutate:${tenantId}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitError) return { error: rateLimitError };

  // 更新後の名前と説明を取り出す
  const name = (formData.get('name') ?? '').toString().trim();
  const rawDescription = (formData.get('description') ?? '').toString().trim();
  // 説明を 500 文字に切り詰める (DoS 対策 — PostgreSQL TEXT は無制限だが上限を設ける)
  const description = rawDescription.slice(0, 500) || null;

  // 拠点名の必須チェック
  if (!name) {
    return { error: '拠点名は必須です' };
  }
  // 拠点名の文字数上限チェック
  if (name.length > 100) {
    return { error: '拠点名は100文字以内で入力してください' };
  }

  try {
    // tenantId をスコープに含めて更新 (他テナントの拠点を変更できないよう保護)
    await repos.locations.update(locationId, tenantId, { name, description });
    // 設定ページのキャッシュを無効化して更新結果がすぐ反映されるようにする
    revalidatePath('/settings');

    // §4.3 フォローアップ: 監査ログに「誰が拠点を更新したか」を記録する
    await recordSettingsAudit({
      tenantId,
      actorId: gate.userId,
      action: 'location_update',
      logPrefix: '[update-location]',
    });

    // 成功を返す
    return { success: true };
  } catch (err) {
    // 拠点名の重複エラー (Prisma の一意制約違反、または memory アダプタの相当エラー) を
    // 共通ヘルパーで検出し、ユーザー向けメッセージに変換する
    if (isUniqueConstraintError(err)) {
      return { error: 'この拠点名はすでに使用されています' };
    }
    // 存在しない拠点 ID のエラー (この判定にのみ使うメッセージ文字列)
    const message = err instanceof Error ? err.message : '';
    if (message.includes('RecordNotFound') || message.includes('not found')) {
      return { error: '拠点が見つかりません' };
    }
    // その他のエラーはログに残して汎用メッセージを返す
    console.error('[update-location] 拠点更新エラー:', err);
    return { error: '拠点の更新に失敗しました' };
  }
}
