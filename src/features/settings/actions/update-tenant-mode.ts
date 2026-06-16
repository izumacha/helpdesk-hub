'use server';

// ページキャッシュを無効化する Next.js の関数
import { revalidatePath } from 'next/cache';
// 現在のセッション (ログイン中ユーザー) を取得
import { auth } from '@/lib/auth';
// リポジトリ束 (repos) を取り込む (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 連打防止のための共通レート制限ヘルパー
import { enforceRateLimit } from '@/lib/rate-limit';
// テナントモード入力 (lite | pro) の Zod 検証スキーマ
import { tenantModeSchema } from '@/lib/validations/tenant';
// next-auth のセッション型
import type { Session } from 'next-auth';

// セッションが管理者 (admin) 権限を持つことを保証するアサーション関数
// テナント全体の動作モード変更は組織設定にあたるため、agent ではなく admin のみ許可する
function assertAdminSession(session: Session | null): asserts session is Session {
  // 未ログイン (ユーザー ID 無し) は拒否
  if (!session?.user?.id) throw new Error('ログインが必要です');
  // tenantId 不在は middleware で弾く想定だが、Server Action でも防御的にチェック
  if (!session.user.tenantId) throw new Error('ログインが必要です');
  // admin 以外 (agent / requester) は拒否 (テナント設定は管理者専用)
  if (session.user.role !== 'admin') {
    throw new Error('この操作は管理者のみ実行できます');
  }
}

// テナントの動作モード (lite | pro) を切り替えるサーバーアクション
export async function updateTenantMode(formData: FormData): Promise<void> {
  // セッション取得
  const session = await auth();
  // 管理者権限を要求 (失敗時は日本語エラーを throw)
  assertAdminSession(session);
  // セッションから tenantId を取り出す (更新対象はログイン中テナントのみ = クロステナント防止)
  const tenantId = session.user.tenantId;
  // 設定変更の連打を抑制 (60 秒あたり 10 回まで、ユーザー単位)
  enforceRateLimit(`tenant-mode:${session.user.id}`, { limit: 10, windowMs: 60_000 });

  // フォームから mode の生値を取り出す (input[name="mode"])
  const rawMode = formData.get('mode');
  // Zod で 'lite' | 'pro' のいずれかであることを検証 (不正値は拒否)
  const parsed = tenantModeSchema.safeParse(rawMode);
  // 検証失敗ならユーザー向け日本語メッセージで throw
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'モードの指定が正しくありません');
  }

  // テナントの mode 列を更新 (id はセッション由来の tenantId のみ)
  await repos.tenants.updateMode(tenantId, parsed.data);

  // モード変更はラベル・遷移表・メニュー表示など広範囲に影響するため、
  // 設定画面と主要画面 (一覧 / ダッシュボード) のキャッシュを無効化して再描画させる
  revalidatePath('/settings');
  revalidatePath('/tickets');
  revalidatePath('/dashboard');
}
