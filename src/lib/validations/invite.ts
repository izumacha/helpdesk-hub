// Zod (スキーマ検証ライブラリ) をインポート
import { z } from 'zod';

// 招待リンクで付与できる権限は「メンバー (requester)」か「担当者 (agent)」のみ。
// admin はリンク経由で付与しない (テナント作成フォームで初代管理者を作る運用)。
export const invitableRoleSchema = z.enum(['requester', 'agent'], {
  message: '権限の指定が正しくありません',
});

// 招待リンク発行フォームの入力検証スキーマ
// - role: 必須 (メンバー / 担当者)
// - email: 任意 (リンク手渡しもあるため)。指定時はメール形式 + 小文字正規化
export const createInvitationSchema = z.object({
  // 付与する権限
  role: invitableRoleSchema,
  // 宛先メール (任意)。空文字は「未指定」として扱い null に正規化する
  email: z
    .string()
    .trim()
    .max(320, 'メールアドレスが長すぎます')
    .email('正しいメールアドレスを入力してください')
    .transform((v) => v.toLowerCase())
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

// パスワードの最小長 (招待受諾・テナント作成で共通利用するため定数化)
export const PASSWORD_MIN_LENGTH = 8;
// パスワードの最大長 (bcrypt は 72 byte までしか見ないため、過大入力を弾く)
export const PASSWORD_MAX_LENGTH = 72;
// 表示名の最大長 (DB は無制限だが現実的な上限を設ける)
export const NAME_MAX_LENGTH = 100;

// パスワード入力の共通スキーマ (受諾・テナント作成で再利用)
const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `パスワードは${PASSWORD_MIN_LENGTH}文字以上で入力してください`)
  .max(PASSWORD_MAX_LENGTH, `パスワードは${PASSWORD_MAX_LENGTH}文字以下で入力してください`);

// 表示名入力の共通スキーマ
const nameSchema = z
  .string()
  .trim()
  .min(1, 'お名前は必須です')
  .max(NAME_MAX_LENGTH, 'お名前が長すぎます');

// メール入力の共通スキーマ (必須・正規化)。招待受諾でユーザー入力メールの検証にも使うため export する
export const emailSchema = z
  .string()
  .trim()
  .min(1, 'メールアドレスは必須です')
  .max(320, 'メールアドレスが長すぎます')
  .email('正しいメールアドレスを入力してください')
  .transform((v) => v.toLowerCase());

// 招待受諾フォームの入力検証スキーマ (氏名 + パスワード設定)。
// tenantId / role は招待行から取り出すため入力に含めない (クロステナント参加の防止)。
export const acceptInvitationSchema = z.object({
  // 表示名
  name: nameSchema,
  // 設定するパスワード
  password: passwordSchema,
});

// テナント作成フォーム (運用者向け最小) の入力検証スキーマ。
// 組織名 + 業種 (任意) + 初代管理者の氏名 / メール / パスワード。
export const createTenantSchema = z.object({
  // 組織名
  tenantName: z
    .string()
    .trim()
    .min(1, '組織名は必須です')
    .max(NAME_MAX_LENGTH, '組織名が長すぎます'),
  // 業種テンプレ識別子 (任意。Phase 3 のカテゴリ初期投入で利用予定)
  industry: z
    .string()
    .trim()
    .max(NAME_MAX_LENGTH, '業種が長すぎます')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  // 初代管理者の氏名
  adminName: nameSchema,
  // 初代管理者のメール
  adminEmail: emailSchema,
  // 初代管理者のパスワード
  adminPassword: passwordSchema,
});

// スキーマから TypeScript 型を生成
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
export type CreateTenantInput = z.infer<typeof createTenantSchema>;
