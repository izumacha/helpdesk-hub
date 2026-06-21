// Zod (スキーマ検証ライブラリ) をインポート
import { z } from 'zod';

// YYYY-MM-DD 文字列が実在する日付か (例: 2026-02-31 は false) を判定するヘルパー
// JavaScript の Date コンストラクタは存在しない日付を自動的にロールオーバーするため、
// 入力された年月日と Date オブジェクトから再構築した年月日が一致するかを確認する
function isRealCalendarDate(yyyyMmDd: string): boolean {
  // 入力を年・月・日の数値に分解 (フォーマットは事前 regex で保証済み)
  const [yearStr, monthStr, dayStr] = yyyyMmDd.split('-');
  // 数値に変換 (月は 0 始まりに揃える)
  const year = Number(yearStr);
  const month = Number(monthStr) - 1;
  const day = Number(dayStr);
  // ローカルタイム基準で Date オブジェクトを構築
  const d = new Date(year, month, day);
  // 入力値と構築後の値が一致すれば実在する日付
  return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day;
}

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
  // 拠点 ID (任意): Phase 4 多拠点で拠点を選択した場合に設定する
  // 空文字は「未選択」として undefined に正規化する
  locationId: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  // 期限日 (Lite モードの簡易フォーム用、任意): YYYY-MM-DD 形式の文字列
  // - <input type="date"> から空文字で送られて来ることがあるので空は undefined に正規化
  // - 形式と実在日付の両方を検証する (例: 2026-02-31 のような不正値を弾く)
  dueDate: z
    .string()
    .optional()
    .refine((v) => v === undefined || v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), {
      message: '期限日の形式が正しくありません',
    })
    .refine((v) => v === undefined || v === '' || isRealCalendarDate(v), {
      message: '期限日が正しい日付ではありません',
    })
    .transform((v) => (v ? v : undefined)),
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
