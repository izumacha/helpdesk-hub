// Zod (スキーマ検証ライブラリ) をインポート
import { z } from 'zod';

// テナントの動作モード切替フォームの入力検証スキーマ
// 値は 'lite' か 'pro' のいずれかのみ許可する (それ以外は不正値として拒否)
export const tenantModeSchema = z.enum(['lite', 'pro'], {
  // 不正な値が来た場合のユーザー向け日本語エラーメッセージ
  message: 'モードの指定が正しくありません',
});
