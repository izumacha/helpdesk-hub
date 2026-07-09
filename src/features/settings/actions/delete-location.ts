'use server';

// Phase 4 多拠点: 拠点を削除する Server Action。
// 管理者のみが拠点を削除できる。削除すると紐づくチケットの locationId が null になる。
// docs/smb-dx-pivot-plan.md §5.2「多店舗・多拠点対応」

// データリポジトリ
import { repos } from '@/data';
// 設定ページのキャッシュを無効化するための Next.js キャッシュ関数
import { revalidatePath } from 'next/cache';
// 「ログイン済み・admin・自テナント」を検証する共有ゲート (throw せず {ok,error} を返す契約)
import { assertTenantAdmin } from '@/lib/tenant-admin-gate';
// 連打防止のための共通レート制限ヘルパー
import { checkRateLimit } from '@/lib/rate-limit';

// 削除結果の戻り値型
export interface DeleteLocationResult {
  // 成功フラグ (成功時に true)
  success?: boolean;
  // エラーメッセージ (失敗時)
  error?: string;
}

// 拠点を削除するサーバーアクション (紐づくチケットの locationId は SetNull)
export async function deleteLocation(locationId: string): Promise<DeleteLocationResult> {
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

  try {
    // tenantId をスコープに含めて削除 (他テナントの拠点を削除できないよう保護)
    await repos.locations.delete(locationId, tenantId);
    // 設定ページのキャッシュを無効化して削除結果がすぐ反映されるようにする
    revalidatePath('/settings');

    // §4.3 フォローアップ: 監査ログに「誰が拠点を削除したか」を記録する。
    // 削除自体は既に完了済みなので、監査ログの書き込みだけが失敗しても
    // 管理者に「削除に失敗した」という誤ったエラーを見せてはいけない
    try {
      await repos.settingsAudit.record({
        tenantId,
        actorId: gate.userId,
        action: 'location_delete',
      });
    } catch (auditErr) {
      console.error('[delete-location] 監査ログの記録に失敗しました:', auditErr);
    }

    // 成功を返す
    return { success: true };
  } catch (err) {
    // その他のエラーはログに残して汎用メッセージを返す
    console.error('[delete-location] 拠点削除エラー:', err);
    return { error: '拠点の削除に失敗しました' };
  }
}
