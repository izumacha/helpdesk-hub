// Route Handler (Next.js API ルート) 向けのレート制限ラッパー。
// /code-review ultra 指摘対応: 「enforceRateLimit を try/catch し、RateLimitError なら
// 429 + Retry-After の NextResponse を返す」という同一の 10 行前後のコードが
// inbound/email/route.ts (インライン)・inbound/line/route.ts (ローカル関数)・
// sso/[tenantId]/acs/route.ts (ローカル関数) の 3 箇所に複製されていたため
// (CLAUDE.md §6「2〜3 箇所目で共通化する」を超過)、ここに集約する。
//
// src/lib/rate-limit.ts の checkRateLimit (Server Action 向け・string | null を返す契約) とは
// 戻り値の型が異なるため、同名衝突を避けて別名にしている (Route Handler は NextResponse を返す
// 契約、Server Action は {error} 用のメッセージ文字列を返す契約で、用途が異なる)。

// HTTP レスポンス生成
import { NextResponse } from 'next/server';
// レート制限の本体とオプション型・専用エラー型
import { enforceRateLimit, RateLimitError, type RateLimitOptions } from '@/lib/rate-limit';

// レート制限を適用し、超過していれば 429 + Retry-After の NextResponse を返す。
// 超過なしなら null を返し、呼び出し側はそのまま処理を続行する。
export function checkRouteRateLimit(
  key: string, // レート制限のキー (呼び出し元がスコープを決める)
  options: RateLimitOptions, // 制限値 (limit / windowMs)
  errorMessage: string, // 超過時にクライアントへ返す日本語メッセージ (呼び出し元の文脈に合わせる)
): NextResponse | null {
  try {
    // 同期の流量制限チェック (超過時は RateLimitError を throw する)
    enforceRateLimit(key, options);
    // 超過なし: 呼び出し側へ処理続行を伝える
    return null;
  } catch (err) {
    // 流量超過専用エラーだけを 429 にマップ。それ以外は想定外なので上位へ再 throw する
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { error: errorMessage },
        { status: 429, headers: { 'Retry-After': String(err.retryAfterSec) } },
      );
    }
    throw err;
  }
}
