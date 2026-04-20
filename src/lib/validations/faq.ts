// Zod (スキーマ検証ライブラリ) をインポート
import { z } from 'zod';

// FAQ 候補フォームの入力検証スキーマ (質問と回答)
export const faqCandidateSchema = z.object({
  // 質問文: 前後空白を削り、1〜2000 文字に収まること
  question: z
    .string()
    .trim()
    .min(1, '質問を入力してください')
    .max(2_000, '質問は2000文字以内で入力してください'),
  // 回答文: 前後空白を削り、1〜2000 文字に収まること
  answer: z
    .string()
    .trim()
    .min(1, '回答を入力してください')
    .max(2_000, '回答は2000文字以内で入力してください'),
});
