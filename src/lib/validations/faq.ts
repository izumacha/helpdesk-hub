import { z } from 'zod';

export const faqCandidateSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, '質問を入力してください')
    .max(2_000, '質問は2000文字以内で入力してください'),
  answer: z
    .string()
    .trim()
    .min(1, '回答を入力してください')
    .max(2_000, '回答は2000文字以内で入力してください'),
});
