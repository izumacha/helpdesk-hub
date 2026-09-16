// Zod (スキーマ検証ライブラリ) をインポート
import { z } from 'zod';
// チケット作成スキーマから件名/内容の規則をそのまま再利用する (§6 DRY: 上限値を書き写さない)
import { createTicketSchema } from '@/lib/validations/ticket';

// 起票前 FAQ 提案 (AI FAQ 自己解決) の入力検証スキーマ。
// 起票フォームの下書き (件名・内容) をそのまま受け取るため、規則はチケット作成と同一にする
export const suggestFaqInputSchema = createTicketSchema.pick({ title: true, body: true });

// 決着記録の入力検証スキーマ (記録 ID + 決着 + 起票時のチケット ID)
export const recordDeflectionOutcomeSchema = z.object({
  // 記録 ID: cuid 相当の短い文字列 (空や異常に長い値を弾く)
  eventId: z.string().trim().min(1).max(64),
  // 決着: 解決した (resolved) か、起票に進んだ (proceeded) か
  outcome: z.enum(['resolved', 'proceeded']),
  // 起票に進んだときのチケット ID (任意)。空文字は未指定として扱う
  ticketId: z
    .string()
    .trim()
    .max(64)
    .optional()
    .transform((v) => v || undefined),
});

// フォーム/アクションで使う型
export type SuggestFaqInput = z.infer<typeof suggestFaqInputSchema>;
export type RecordDeflectionOutcomeInput = z.infer<typeof recordDeflectionOutcomeSchema>;
