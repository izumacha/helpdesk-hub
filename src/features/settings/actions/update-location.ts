'use server';

// Phase 4 多拠点: 既存の拠点情報を更新する Server Action。
// 管理者のみが拠点を編集できる。
// docs/smb-dx-pivot-plan.md §5.2「多店舗・多拠点対応」

// セッション取得
import { auth } from '@/lib/auth';
// データリポジトリ
import { repos } from '@/data';

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
  // セッション取得と認証チェック
  const session = await auth();
  // 未ログインまたは tenantId 不在は拒否
  if (!session?.user?.id || !session.user.tenantId) {
    return { error: '認証が必要です' };
  }
  // 管理者のみが拠点を更新できる
  if (session.user.role !== 'admin') {
    return { error: 'この操作は管理者のみ実行できます' };
  }

  // 更新後の名前と説明を取り出す
  const name = (formData.get('name') ?? '').toString().trim();
  const description = (formData.get('description') ?? '').toString().trim() || null;

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
    // 成功を返す
    return { success: true };
  } catch (err) {
    // 拠点名の重複エラーをユーザー向けメッセージに変換する
    const message = err instanceof Error ? err.message : '';
    // Prisma の一意制約違反または memory アダプタのエラーを検出する
    if (message.includes('Unique constraint') || message.includes('already exists') || message.includes('P2002')) {
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
