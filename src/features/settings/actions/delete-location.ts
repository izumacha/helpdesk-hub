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
// 管理者権限を強制する共通アサーション (組織設定系で共有)
import { assertAdminSession } from '@/lib/role';
// 連打防止のための共通レート制限ヘルパー
import { enforceRateLimit } from '@/lib/rate-limit';

// 削除結果の戻り値型
export interface DeleteLocationResult {
  // 成功フラグ (成功時に true)
  success?: boolean;
  // エラーメッセージ (失敗時)
  error?: string;
}

// 拠点を削除するサーバーアクション (紐づくチケットの locationId は SetNull)
export async function deleteLocation(locationId: string): Promise<DeleteLocationResult> {
  // セッション取得
  const session = await auth();
  // 管理者権限の確認とレート制限を行う。このアクションは throw せず常に {error} を返す契約
  // (呼び出し元の LocationsSection.tsx が try/catch を持たないため) なので、
  // 共有ヘルパーが投げる例外をここで捕まえて変換する
  try {
    assertAdminSession(session);
    // 拠点削除の連打を抑制 (60 秒あたり 10 回まで、ユーザー単位)
    enforceRateLimit(`location-delete:${session.user.id}`, { limit: 10, windowMs: 60_000 });
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'この操作は管理者のみ実行できます' };
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
