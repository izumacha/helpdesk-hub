'use server';

// Phase 4 多拠点: 拠点を削除する Server Action。
// 管理者のみが拠点を削除できる。削除すると紐づくチケットの locationId が null になる。
// docs/smb-dx-pivot-plan.md §5.2「多店舗・多拠点対応」

// セッション取得
import { auth } from '@/lib/auth';
// データリポジトリ
import { repos } from '@/data';
// 設定ページのキャッシュを無効化するための Next.js キャッシュ関数
import { revalidatePath } from 'next/cache';

// 削除結果の戻り値型
export interface DeleteLocationResult {
  // 成功フラグ (成功時に true)
  success?: boolean;
  // エラーメッセージ (失敗時)
  error?: string;
}

// 拠点を削除するサーバーアクション (紐づくチケットの locationId は SetNull)
export async function deleteLocation(locationId: string): Promise<DeleteLocationResult> {
  // セッション取得と認証チェック
  const session = await auth();
  // 未ログインまたは tenantId 不在は拒否
  if (!session?.user?.id || !session.user.tenantId) {
    return { error: '認証が必要です' };
  }
  // 管理者のみが拠点を削除できる
  if (session.user.role !== 'admin') {
    return { error: 'この操作は管理者のみ実行できます' };
  }

  try {
    // tenantId をスコープに含めて削除 (他テナントの拠点を削除できないよう保護)
    await repos.locations.delete(locationId, session.user.tenantId);
    // 設定ページのキャッシュを無効化して削除結果がすぐ反映されるようにする
    revalidatePath('/settings');
    // 成功を返す
    return { success: true };
  } catch (err) {
    // その他のエラーはログに残して汎用メッセージを返す
    console.error('[delete-location] 拠点削除エラー:', err);
    return { error: '拠点の削除に失敗しました' };
  }
}
