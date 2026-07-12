// Zod (スキーマ検証ライブラリ) をインポート
import { z } from 'zod';

// Stripe Checkout を経由してセルフサーブでアップグレードできるプランは
// standard / pro の 2 つのみ (free はチェックアウト不要、enterprise は個別見積のため
// createCheckoutSession の手前で明示的に弾く)。Server Action は POST エンドポイントとして
// 直接叩けるため、TypeScript の引数型はコンパイル時の契約に過ぎず実行時の保証にならない。
// 不正な値(未定義の文字列等)を Pro の Price ID へ暗黙にフォールバックさせないよう、
// ここで許可リスト検証する(§9 入力は信用しない)。
export const checkoutTargetPlanSchema = z.enum(['standard', 'pro'], {
  message: 'プランの指定が正しくありません',
});
