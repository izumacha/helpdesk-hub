'use server';

/**
 * テナント作成サーバーアクション (運用者向け・管理者専用)。
 *
 * 新しい組織 (テナント) と、その初代管理者 (admin) ユーザーを 1 件ずつ作成する。
 * Phase 3 オンボーディングとして、業種テンプレに応じたカテゴリ投入に加え、
 * 操作感を掴むためのサンプルチケットを自動作成する (実体は provisionTenantWithAdmin に集約)。
 *
 * セキュリティ要点:
 *  - 実行は admin のみ (assertAdminSession)。作成テナントは呼び出し元テナントと独立。
 *  - テナント作成とユーザー作成を 1 トランザクションで行い、ユーザー作成失敗時 (メール重複等) は
 *    テナント作成もロールバックして孤児テナントを残さない。
 *  - パスワードは bcrypt でハッシュ化して保存する (平文は保存しない / §9)。
 */

// データ層の Composition Root (リポジトリ束とトランザクション境界)
import { uow } from '@/data';
// 現在のセッション (ログイン中ユーザー) を取得
import { auth } from '@/lib/auth';
// 連打防止のための共通レート制限ヘルパー
import { enforceRateLimit } from '@/lib/rate-limit';
// 管理者権限を強制する共通アサーション
import { assertAdminSession } from '@/lib/role';
// テナント作成フォームの入力検証スキーマ
import { createTenantSchema } from '@/lib/validations/invite';
// §7.2 Free trial の期間 (30 日) をミリ秒で表す定数
import { FREE_TRIAL_DURATION_MS } from '@/lib/plan-guard';
// テナント + 初代管理者作成の共通ロジック (§7.1 セルフサーブサインアップと共有 / §6 DRY)
import { provisionTenantWithAdmin } from '@/lib/tenant-provisioning';

// createTenant の戻り値型 (作成したテナント ID と初代管理者メールを返す)
export interface CreateTenantResult {
  tenantId: string; // 作成したテナントの ID
  adminEmail: string; // 初代管理者のログイン用メール
}

// 新しいテナント + 初代管理者を作成するサーバーアクション。フォーム (FormData) から呼ぶ
export async function createTenant(formData: FormData): Promise<CreateTenantResult> {
  // セッション取得
  const session = await auth();
  // 管理者権限を要求 (失敗時は日本語エラーを throw)
  assertAdminSession(session);
  // テナント作成の連打を抑制 (60 秒あたり 5 回まで、ユーザー単位)
  enforceRateLimit(`tenant-create:${session.user.id}`, { limit: 5, windowMs: 60_000 });

  // フォーム入力を Zod で検証する
  const parsed = createTenantSchema.safeParse({
    tenantName: formData.get('tenantName'),
    // 任意フィールドはフォーム未送信時に null になるため空文字へ正規化する (スキーマは '' を許容)
    industry: formData.get('industry') ?? '',
    adminName: formData.get('adminName'),
    adminEmail: formData.get('adminEmail'),
    adminPassword: formData.get('adminPassword'),
  });
  // 検証失敗ならユーザー向け日本語メッセージで throw
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? '入力が正しくありません');
  }
  // 検証済みの入力値 (industry は未指定なら undefined)
  const { tenantName, industry, adminName, adminEmail, adminPassword } = parsed.data;

  // テナント作成 → 初代管理者作成を 1 トランザクションで行う。
  // ユーザー作成 (メール重複等) で失敗したらテナント作成もロールバックして孤児を残さない。
  // §7.2「30日間の Free trial (Standard 相当)」: 作成時刻から 30 日後を trialEndsAt に設定する。
  // これにより §7.1「30分で運用開始」オンボーディングのメール取り込み体験 (Standard 以上限定)
  // を、課金前の新規テナントでもすぐに試せるようにする
  const result = await uow.run(async (tx) => {
    const { tenantId } = await provisionTenantWithAdmin(tx, {
      tenantName,
      industry,
      adminName,
      adminEmail,
      adminPassword,
      trialEndsAt: new Date(Date.now() + FREE_TRIAL_DURATION_MS),
    });
    // 作成結果を返す
    return { tenantId, adminEmail };
  });

  // 作成したテナント ID と管理者メールを返す
  return result;
}
