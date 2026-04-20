// Zod (スキーマ検証ライブラリ) をインポート
import { z } from 'zod';

// チケット新規作成フォームの入力検証スキーマ
export const createTicketSchema = z.object({
  // タイトル: 1〜200 文字の文字列
  title: z
    .string()
    .min(1, 'タイトルは必須です') // 空文字を許さない
    .max(200, 'タイトルは200文字以内で入力してください'), // 上限制約
  // 本文: 1〜10000 文字
  body: z.string().min(1, '内容は必須です').max(10_000, '内容は10000文字以内で入力してください'),
  // カテゴリ ID: 任意。空文字なら undefined に変換 (未選択扱い)
  categoryId: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  // 優先度は Low/Medium/High のいずれか
  priority: z.enum(['Low', 'Medium', 'High']),
});

// スキーマから TypeScript 型を生成 (変換後の型)
export type CreateTicketInput = z.infer<typeof createTicketSchema>;
// フォーム入力時の生の型 (transform 前) を生成
export type CreateTicketFormValues = z.input<typeof createTicketSchema>;

// コメント本文の検証スキーマ (前後空白トリム、1〜5000 文字)
export const commentBodySchema = z
  .string()
  .trim() // 前後の空白を削除
  .min(1, 'コメントを入力してください')
  .max(5_000, 'コメントは5000文字以内で入力してください');

// エスカレーション理由の検証スキーマ (前後空白トリム、1〜1000 文字)
export const escalationReasonSchema = z
  .string()
  .trim()
  .min(1, 'エスカレーション理由を入力してください')
  .max(1_000, 'エスカレーション理由は1000文字以内で入力してください');
