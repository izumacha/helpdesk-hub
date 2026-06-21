'use server';

/**
 * テナント作成サーバーアクション (運用者向け・管理者専用)。
 *
 * 新しい組織 (テナント) と、その初代管理者 (admin) ユーザーを 1 件ずつ作成する。
 * セルフサーブ・サインアップやオンボーディングウィザード (業種テンプレ自動投入等) は
 * Phase 3 の領域なので、ここでは「組織 + 初代管理者を作るだけ」の最小フォームに留める。
 *
 * セキュリティ要点:
 *  - 実行は admin のみ (assertAdminSession)。作成テナントは呼び出し元テナントと独立。
 *  - テナント作成とユーザー作成を 1 トランザクションで行い、ユーザー作成失敗時 (メール重複等) は
 *    テナント作成もロールバックして孤児テナントを残さない。
 *  - パスワードは bcrypt でハッシュ化して保存する (平文は保存しない / §9)。
 */

// bcrypt によるパスワードハッシュ化 (seed と同じ cost 12)
import { hash } from 'bcryptjs';
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
// メール取り込み用の転送アドレストークンを払い出すヘルパー (Phase 2)
import { generateInboundToken } from '@/lib/inbound-email';
// 業種テンプレートの検索関数 (Phase 3 業種テンプレ自動投入)
import { findIndustryTemplate } from '@/lib/industry-templates';

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
  const result = await uow.run(async (tx) => {
    // 先にメール重複を確認 (テナントを作る前に弾けるならその方が無駄がない)
    const existing = await tx.users.findByEmail(adminEmail);
    if (existing) {
      throw new Error('このメールアドレスは既に登録されています。別のメールを指定してください。');
    }

    // 新しいテナント (組織) を作成する。mode 未指定で SMB 既定の lite になる。
    // メール取り込み (Phase 2) の専用転送アドレス用トークンを払い出して紐付ける
    // (作成時に発行しておくことで、運用者は最初から取り込みアドレスを案内できる)
    const tenant = await tx.tenants.create({
      name: tenantName,
      industry: industry ?? null,
      inboundToken: generateInboundToken(),
    });
    // パスワードを bcrypt でハッシュ化する (cost 12)
    const passwordHash = await hash(adminPassword, 12);
    // 初代管理者 (admin) を作成テナントに所属させて作る
    await tx.users.create({
      email: adminEmail,
      name: adminName,
      passwordHash,
      role: 'admin',
      tenantId: tenant.id,
    });
    // 業種テンプレートが指定されている場合はカテゴリを初期投入する
    // (Phase 3 業種テンプレ: 選択した業種に紐づくカテゴリを 1 件ずつ作成する)
    if (industry) {
      // 指定 ID のテンプレートを取得する (存在しなければ undefined)
      const template = findIndustryTemplate(industry);
      // テンプレートが見つかった場合のみカテゴリを順次作成する
      if (template) {
        // Prisma のインタラクティブトランザクション内では 1 つの接続を直列に使うため
        // Promise.all で並列クエリを投げると "Transaction already closed" になる場合がある。
        // for...of + await で直列実行して安全性を保つ (カテゴリは数件なので性能上問題なし)
        for (const name of template.categories) {
          // カテゴリを 1 件ずつトランザクション内で作成する
          await tx.categories.create({ name, tenantId: tenant.id });
        }
      }
    }
    // 作成結果を返す
    return { tenantId: tenant.id, adminEmail };
  });

  // 作成したテナント ID と管理者メールを返す
  return result;
}
