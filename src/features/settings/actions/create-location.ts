'use server';

// Phase 4 多拠点: テナント内の拠点を新規作成する Server Action。
// 管理者のみが拠点を追加できる (拠点はテナント全体の設定)。
// docs/smb-dx-pivot-plan.md §5.2「多店舗・多拠点対応」

// セッション取得
import { auth } from '@/lib/auth';
// データリポジトリ
import { repos } from '@/data';

// 作成結果の戻り値型
export interface CreateLocationResult {
  // 作成された拠点 ID (成功時)
  locationId?: string;
  // エラーメッセージ (失敗時)
  error?: string;
}

// 拠点を新規作成するサーバーアクション
export async function createLocation(formData: FormData): Promise<CreateLocationResult> {
  // セッション取得と認証チェック
  const session = await auth();
  // 未ログインまたは tenantId 不在は拒否
  if (!session?.user?.id || !session.user.tenantId) {
    return { error: '認証が必要です' };
  }
  // 管理者のみが拠点を作成できる
  if (session.user.role !== 'admin') {
    return { error: 'この操作は管理者のみ実行できます' };
  }

  // フォームデータから入力値を取り出す
  const name = (formData.get('name') ?? '').toString().trim();
  const rawDescription = (formData.get('description') ?? '').toString().trim();
  // 説明を 500 文字に切り詰める (DoS 対策 — PostgreSQL TEXT は無制限だが上限を設ける)
  const description = rawDescription.slice(0, 500) || null;

  // 拠点名の必須チェック (1〜100 文字)
  if (!name) {
    return { error: '拠点名は必須です' };
  }
  // 拠点名の文字数上限チェック
  if (name.length > 100) {
    return { error: '拠点名は100文字以内で入力してください' };
  }

  try {
    // 拠点を DB に作成する (tenantId はセッション由来のみを使いクロステナント防止)
    const location = await repos.locations.create({
      tenantId: session.user.tenantId,
      name,
      description,
    });
    // 作成された拠点 ID を返す
    return { locationId: location.id };
  } catch (err) {
    // 拠点名の重複エラーをユーザー向けメッセージに変換する
    const message = err instanceof Error ? err.message : '';
    // Prisma の一意制約違反 (P2002) または memory アダプタのエラーを検出する
    if (message.includes('Unique constraint') || message.includes('already exists') || message.includes('P2002')) {
      return { error: 'この拠点名はすでに使用されています' };
    }
    // その他のエラーはログに残して汎用メッセージを返す
    console.error('[create-location] 拠点作成エラー:', err);
    return { error: '拠点の作成に失敗しました' };
  }
}
