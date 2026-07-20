'use server';

/**
 * セルフサーブサインアップ完了サーバーアクション (公開)。
 *
 * サインアップ完了リンクのトークンと、入力された組織名・業種・初代管理者の氏名・パスワードを
 * 受け取り、新しいテナント + 初代管理者を作成する (実体は provisionTenantWithAdmin に委譲)。
 * トークンが「秘密」であることが認可の根拠なので auth() は不要 (公開アクション。
 * accept-invitation.ts と同じ設計思想)。
 *
 * セキュリティ要点:
 *  - adminEmail はリクエスト入力に一切含めない。**SignupToken (consumeValidToken の戻り値)
 *    からのみ**取り出す (トークン発行時点で検証済みのメール以外を admin にできないようにする)。
 *  - 消費 (単回使用ガード) とテナント + ユーザー作成を 1 トランザクションで行い、
 *    作成失敗時は消費もロールバックしてトークンを無駄に焼かない。
 *  - パスワードは bcrypt でハッシュ化して保存する (平文は保存しない / §9。provisionTenantWithAdmin 内)。
 *  - 監査で発見したギャップ対応 (2026-07-20): 公開 (未認証) アクションかつ Serializable
 *    トランザクションを伴うため、不正なトークンでの連打による DB 負荷増大を防ぐ固定キーの
 *    全体レート制限を最初に適用する (accept-invitation.ts / requestMagicLink と同じ設計)。
 */

// データ層の Composition Root (トランザクション境界。リポジトリはトランザクション内の tx 経由で使う)
import { uow } from '@/data';
// §7.2 Free trial の期間 (30 日) をミリ秒で表す定数
import { FREE_TRIAL_DURATION_MS } from '@/lib/plan-guard';
// Prisma の一意制約違反 (P2002) 判定の共通ヘルパー (accept-invitation.ts と共有 / §6 DRY)
import { isUniqueConstraintError } from '@/lib/prisma-errors';
// 連打防止のための共通レート制限ヘルパー (accept-invitation.ts / request-magic-link.ts と共有)
import { enforceRateLimit } from '@/lib/rate-limit';
// サインアップトークンのハッシュ化 (生トークン → DB 保存値と同じ SHA-256 へ) と、
// このエンドポイント全体のレート制限値 (監査で発見したギャップ対応)
import { hashSignupToken, SIGNUP_COMPLETE_GLOBAL_RATE_LIMIT } from '@/lib/signup';
// テナント + 初代管理者作成の共通ロジック (create-tenant.ts と共有 / §6 DRY)
import { provisionTenantWithAdmin } from '@/lib/tenant-provisioning';
// フォローアップ (2026-07-14 #2): テナント作成 (admin 権限付与) を監査ログへ記録する共通ヘルパー
import { recordSettingsAudit } from '@/lib/settings-audit';
// 完了フォームの入力検証スキーマ
import { completeSignupSchema } from '@/lib/validations/signup';

// completeSignup の戻り値型。作成に使ったメールを返し、クライアントがそのままログインに使う
export interface CompleteSignupResult {
  email: string; // 作成した初代管理者のログイン用メール
}

// サインアップを完了してテナント + 初代管理者を作成するサーバーアクション。
// rawToken は完了ページの URL から、tenantName/industry/adminName/adminPassword はフォームから渡る。
export async function completeSignup(
  rawToken: string,
  formData: FormData,
): Promise<CompleteSignupResult> {
  // 監査で発見したギャップ対応: 公開 (未認証) アクションかつ Serializable トランザクションを
  // 伴うため、不正なトークンでの連打による DB 負荷増大を防ぐ固定キーの全体レート制限を
  // 最初に適用する (§9 公開エンドポイント保護。accept-invitation.ts と同じ設計)
  enforceRateLimit('signup-complete:global', SIGNUP_COMPLETE_GLOBAL_RATE_LIMIT);

  // フォーム入力 (組織名・業種・氏名・パスワード) を Zod で検証する
  const parsed = completeSignupSchema.safeParse({
    tenantName: formData.get('tenantName'),
    // 任意フィールドはフォーム未送信時に null になるため空文字へ正規化する (スキーマは '' を許容)
    industry: formData.get('industry') ?? '',
    adminName: formData.get('adminName'),
    adminPassword: formData.get('adminPassword'),
  });
  // 検証失敗ならユーザー向け日本語メッセージで throw
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? '入力が正しくありません');
  }
  // 検証済みの入力値
  const { tenantName, industry, adminName, adminPassword } = parsed.data;

  // 生トークンを DB 保存値と同じ SHA-256 ハッシュへ変換する
  const tokenHash = await hashSignupToken(rawToken);
  // 消費判定の基準時刻
  const now = new Date();

  // 消費 (単回使用ガード) → テナント + ユーザー作成を 1 トランザクションで行う。
  // 途中で例外が出れば消費もロールバックされ、サインアップリンクは再利用可能なまま残る。
  // フォローアップ (2026-07-14 #2): トランザクション内で作成した tenantId/adminId は、
  // トランザクション外で行う監査ログ記録 (recordSettingsAudit) にも必要なため、
  // クライアントへの戻り値 (email) と合わせて uow.run の戻り値自体に含めて持ち出す
  // (外側の let 変数をクロージャ内で再代入する形だと TypeScript の制御フロー解析が
  // クロージャ内の代入を追えず、代入後も null 型のまま narrow されてしまうため避ける)。
  let provisioned: { email: string; tenantId: string; adminId: string };
  try {
    provisioned = await uow.run(async (tx) => {
      // サインアップトークンを原子的に消費する。未消費かつ失効前のときだけ成功して行を返す
      const signup = await tx.signupTokens.consumeValidToken({ tokenHash, now });
      // 無効 / 失効 / 既使用ならここで中断 (どれも同じ案内にして詮索余地を減らす)
      if (!signup) {
        throw new Error('このリンクは無効か、有効期限が切れているか、既に使用されています。');
      }

      // テナント + 初代管理者を作成する (adminEmail はトークン行由来。入力からは受け取らない)
      const { tenantId, adminId } = await provisionTenantWithAdmin(tx, {
        tenantName,
        industry,
        adminName,
        adminEmail: signup.email,
        adminPassword,
        trialEndsAt: new Date(now.getTime() + FREE_TRIAL_DURATION_MS),
      });

      // クライアントへの戻り値 (email) と監査ログ記録に使う ID をまとめて返す
      return { email: signup.email, tenantId, adminId };
    });
  } catch (err) {
    // /code-review ultra 指摘対応 (accept-invitation.ts の前例に倣う): tx 内の findByEmail
    // 事前チェックをすり抜けて同一メール宛の同時サインアップ完了 (同じメールで requestSignup を
    // 複数回呼び、発行された別々のトークンをほぼ同時に完了させた場合) が競合すると、
    // User.email の一意制約違反が Prisma の生エラーとしてここまで伝播しうる。
    // 他の throw new Error(...) は本アクション自身が投げる安全な日本語メッセージのみなので、
    // 一意制約違反だけを検出して安全なメッセージへ変換する (§9: 内部エラー文言を漏らさない)。
    if (isUniqueConstraintError(err)) {
      console.error('[complete-signup] メール一意制約違反 (競合の可能性):', err);
      throw new Error('このメールアドレスは既に登録されています。ログインしてください。');
    }
    // それ以外 (バリデーションエラー・トークン無効等、本アクション自身が投げた安全な
    // 日本語メッセージ) はそのまま伝播する
    throw err;
  }

  // フォローアップ (2026-07-14 #2): 監査で発見したギャップの解消。テナント作成 (新しい admin
  // 権限の付与) を監査ログに記録する。セルフサーブサインアップには事前セッションが存在しない
  // (トークン自体が認可の根拠) ため、actorId には「操作を行った人物 = 今まさに作成された
  // 初代管理者自身」の ID を使う (Stripe Webhook 起因の actorId: null 「システムによる自動変更」
  // とは異なり、実在する人物の意思による操作であることを区別する)。
  await recordSettingsAudit({
    tenantId: provisioned.tenantId,
    actorId: provisioned.adminId,
    action: 'tenant_create',
    logPrefix: '[complete-signup]',
  });

  // クライアントがログインに使うメールを返す
  return { email: provisioned.email };
}
