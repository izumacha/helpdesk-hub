'use server';

// Phase 4 多拠点: テナント内の拠点を新規作成する Server Action。
// 管理者のみが拠点を追加できる (拠点はテナント全体の設定)。
// docs/smb-dx-pivot-plan.md §5.2「多店舗・多拠点対応」

// データリポジトリ
import { repos } from '@/data';
// 設定ページのキャッシュを無効化するための Next.js キャッシュ関数
import { revalidatePath } from 'next/cache';
// 「ログイン済み・admin・自テナント」を検証する共有ゲート (throw せず {ok,error} を返す契約。
// line-config-context.ts / sso-context.ts と同じ非throw系アクションで共有する)
import { assertTenantAdmin } from '@/lib/tenant-admin-gate';
// 連打防止のための共通レート制限ヘルパー
import { checkRateLimit } from '@/lib/rate-limit';

// 作成結果の戻り値型
export interface CreateLocationResult {
  // 作成された拠点 ID (成功時)
  locationId?: string;
  // エラーメッセージ (失敗時)
  error?: string;
}

// 拠点を新規作成するサーバーアクション
export async function createLocation(formData: FormData): Promise<CreateLocationResult> {
  // 共有ゲートで「ログイン済み・admin・自テナント」をまとめて検証する
  const gate = await assertTenantAdmin();
  // ゲート不通過ならその理由をそのまま返す
  if (!gate.ok) return { error: gate.error };
  // 検証済みの tenantId (セッション由来)
  const tenantId = gate.tenantId;

  // 拠点の作成・更新・削除の連打を抑制 (60 秒あたり 10 回まで、テナント単位で共有)。
  // ユーザー単位ではなくテナント単位にする理由: 拠点は「テナント全体の設定」であり、
  // 同一テナントの複数管理者が個別の枠を持つと合計の操作回数が管理者数倍になり、
  // 制限の意図 (拠点乱造の抑止) を損なう (regenerate-inbound-token.ts と同じ方針)。
  // create/update/delete で同じキーを共有するのも同じ理由 (アクション別に分けると
  // 実質の上限が action 数倍になってしまう)
  const rateLimitError = checkRateLimit(`location-mutate:${tenantId}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitError) return { error: rateLimitError };

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
      tenantId,
      name,
      description,
    });
    // 設定ページのキャッシュを無効化して新しい拠点がすぐ反映されるようにする
    revalidatePath('/settings');
    // 作成された拠点 ID を返す
    return { locationId: location.id };
  } catch (err) {
    // 拠点名の重複エラーをユーザー向けメッセージに変換する
    const message = err instanceof Error ? err.message : '';
    // Prisma の一意制約違反 (P2002) または memory アダプタのエラーを検出する
    if (
      message.includes('Unique constraint') ||
      message.includes('already exists') ||
      message.includes('P2002')
    ) {
      return { error: 'この拠点名はすでに使用されています' };
    }
    // その他のエラーはログに残して汎用メッセージを返す
    console.error('[create-location] 拠点作成エラー:', err);
    return { error: '拠点の作成に失敗しました' };
  }
}
