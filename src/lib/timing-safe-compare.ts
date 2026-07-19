/**
 * Constant-time string equality (timing-attack resistant).
 *
 * /code-review ultra 指摘対応: 当初 LINE Webhook 署名検証 (verifyLineSignature) と
 * trial-reminders の Bearer トークン検証で「長さチェック→timingSafeEqual」という同じ
 * イディオムが 2 箇所に複製されていたため、共通ヘルパーに切り出す (CLAUDE.md §6 DRY)。
 */

// タイミング攻撃対策の定数時間比較
import { timingSafeEqual } from 'node:crypto';

// 2 つの文字列が (タイミング攻撃耐性のある方法で) 一致するか判定する。
// 長さが違う場合は timingSafeEqual が例外を投げるため先に早期 false で返す
// (攻撃者は正解の長さを知り得ても、文字自体の推測難易度は変わらないため安全)
export function constantTimeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// /code-review ultra 指摘対応: trial-reminders/route.ts と sla-reminders/route.ts の両方が
// 「Authorization ヘッダの "Bearer <token>" から token 部分を取り出す」全く同じ実装を
// 個別に持っていた (2 箇所目の重複、CLAUDE.md §6 DRY) ため、constantTimeStringEqual と同じく
// ここに切り出す。共有シークレット認証を行う内部 cron エンドポイントはセットで使う想定
//
// Authorization ヘッダの "Bearer <token>" から token 部分だけを取り出す。
// 形式が違えば null を返す (呼び出し側で認証失敗として扱う)
export function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}
