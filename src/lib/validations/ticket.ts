import { z } from 'zod';

export const createTicketSchema = z.object({
  title: z
    .string()
    .min(1, 'タイトルは必須です')
    .max(200, 'タイトルは200文字以内で入力してください'),
  body: z.string().min(1, '内容は必須です').max(10_000, '内容は10000文字以内で入力してください'),
  categoryId: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  priority: z.enum(['Low', 'Medium', 'High']),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type CreateTicketFormValues = z.input<typeof createTicketSchema>;

export const commentBodySchema = z
  .string()
  .trim()
  .min(1, 'コメントを入力してください')
  .max(5_000, 'コメントは5000文字以内で入力してください');

export const escalationReasonSchema = z
  .string()
  .trim()
  .min(1, 'エスカレーション理由を入力してください')
  .max(1_000, 'エスカレーション理由は1000文字以内で入力してください');
