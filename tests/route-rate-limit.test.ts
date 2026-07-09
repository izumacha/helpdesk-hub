// checkRouteRateLimit (Route Handler 向けレート制限ラッパー) の仕様確認テスト。
// /code-review ultra 指摘対応: inbound-email/inbound-line/sso-acs の 3 ルートに複製されていた
// 「enforceRateLimit を try/catch し、RateLimitError なら 429 の NextResponse を返す」処理を
// src/lib/route-rate-limit.ts に集約した。その集約先自体の単体テスト。

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRateLimits } from '@/lib/rate-limit';
import { checkRouteRateLimit } from '@/lib/route-rate-limit';

describe('checkRouteRateLimit', () => {
  beforeEach(() => {
    __resetRateLimits();
  });

  // 上限以内なら null を返し、呼び出し側が処理を続行できる
  it('returns null when within the limit', () => {
    const result = checkRouteRateLimit('k', { limit: 3, windowMs: 10_000 }, 'メッセージ');
    expect(result).toBeNull();
  });

  // 上限を超えると 429 + Retry-After ヘッダの NextResponse を返す
  it('returns a 429 response with the given message once over the limit', async () => {
    for (let i = 0; i < 3; i++) {
      expect(checkRouteRateLimit('k2', { limit: 3, windowMs: 10_000 }, 'メッセージ')).toBeNull();
    }
    const response = checkRouteRateLimit(
      'k2',
      { limit: 3, windowMs: 10_000 },
      'カスタムメッセージ',
    );
    expect(response).not.toBeNull();
    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toEqual(expect.any(String));
    const body = await response?.json();
    expect(body).toEqual({ error: 'カスタムメッセージ' });
  });

  // 異なるキーは独立してカウントされる
  it('tracks keys independently', () => {
    for (let i = 0; i < 3; i++) {
      checkRouteRateLimit('k3-a', { limit: 3, windowMs: 10_000 }, 'メッセージ');
    }
    // 別キーはまだ上限に達していないので null
    expect(checkRouteRateLimit('k3-b', { limit: 3, windowMs: 10_000 }, 'メッセージ')).toBeNull();
  });
});
