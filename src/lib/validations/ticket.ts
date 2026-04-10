import { z } from 'zod';

export const createTicketSchema = z.object({
  title: z.string().min(1, 'タイトルは必須です').max(200, 'タイトルは200文字以内で入力してください'),
  body: z.string().min(1, '内容は必須です'),
  categoryId: z.string().optional(),
  priority: z.enum(['Low', 'Medium', 'High']),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
