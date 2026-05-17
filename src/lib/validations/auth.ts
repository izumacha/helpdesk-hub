// Zod (スキーマ検証ライブラリ) をインポート
import { z } from 'zod';

// マジックリンク発行リクエストの入力検証スキーマ
// - メール: RFC 準拠の簡易チェック + 小文字正規化 + 前後空白トリム
// - 上限文字数: DB 側 email カラムが無制限のため、現実的に十分な 320 文字 (RFC 5321)
export const requestMagicLinkSchema = z.object({
  // メールアドレス
  email: z
    .string() // 文字列であること
    .trim() // 前後の空白を削除
    .min(1, 'メールアドレスは必須です') // 空文字を許さない
    .max(320, 'メールアドレスが長すぎます') // RFC 5321 の上限
    .email('正しいメールアドレスを入力してください') // メール形式チェック
    .transform((v) => v.toLowerCase()), // 小文字に正規化 (照合キーとして使うため)
});

// スキーマから TypeScript 型を生成 (transform 後の型)
export type RequestMagicLinkInput = z.infer<typeof requestMagicLinkSchema>;
