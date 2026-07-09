'use server';

// Phase 4 多拠点: 既存の拠点情報を更新する Server Action。
// 管理者のみが拠点を編集できる。
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
  // セッション取得
  const session = await auth();
  // 管理者権限の確認とレート制限を行う。このアクションは throw せず常に {error} を返す契約
  // (呼び出し元の LocationsSection.tsx が try/catch を持たないため) なので、
  // 共有ヘルパーが投げる例外をここで捕まえて変換する
  try {
    assertAdminSession(session);
    // 拠点更新の連打を抑制 (60 秒あたり 10 回まで、ユーザー単位)
    enforceRateLimit(`location-update:${session.user.id}`, { limit: 10, windowMs: 60_000 });
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'この操作は管理者のみ実行できます' };
  }

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
    await repos.locations.update(locationId, session.user.tenantId, { name, description });
    // 設定ページのキャッシュを無効化して更新結果がすぐ反映されるようにする
    revalidatePath('/settings');
    // 成功を返す
    return { success: true };
  } catch (err) {
    // 拠点名の重複エラーをユーザー向けメッセージに変換する
    const message = err instanceof Error ? err.message : '';
    // Prisma の一意制約違反または memory アダプタのエラーを検出する
    if (
      message.includes('Unique constraint') ||
      message.includes('already exists') ||
      message.includes('P2002')
    ) {
      return { error: 'この拠点名はすでに使用されています' };
    }
    // 存在しない拠点 ID のエラー
    if (message.includes('RecordNotFound') || message.includes('not found')) {
      return { error: '拠点が見つかりません' };
    }
    // その他のエラーはログに残して汎用メッセージを返す
    console.error('[update-location] 拠点更新エラー:', err);
    return { error: '拠点の更新に失敗しました' };
  }
}
