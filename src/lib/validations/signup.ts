// Zod (スキーマ検証ライブラリ) をインポート
import { z } from 'zod';
// テナント作成フォームと共通の入力検証 (組織名 / 業種 / 氏名 / パスワード) を再利用する (§6 DRY)
import { createTenantSchema, emailSchema } from '@/lib/validations/invite';

// セルフサーブサインアップの発行リクエスト (§7.1) の入力検証スキーマ。
// マジックリンク発行と全く同じ形 (メールのみ) のため同じ制約を踏襲する
export const requestSignupSchema = z.object({
  // メールアドレス
  email: emailSchema,
});

// サインアップ完了フォームの入力検証スキーマ。
// createTenantSchema から adminEmail を除いたもの (メールはトークン発行時点の値を信頼の起点にし、
// 入力からは受け取らない = なりすまし防止。acceptInvitationSchema が招待の tenantId/role を
// 入力に含めないのと同じ設計)。
export const completeSignupSchema = createTenantSchema.omit({ adminEmail: true });

// スキーマから TypeScript 型を生成
export type RequestSignupInput = z.infer<typeof requestSignupSchema>;
export type CompleteSignupInput = z.infer<typeof completeSignupSchema>;
