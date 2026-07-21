// isSameOriginRequest (同一オリジン検証ヘルパー) の仕様確認テスト。
// /code-review ultra 指摘対応: magic-link/callback に個別実装されていた CSRF 判定ロジックを
// src/lib/csrf.ts に集約し、POST /api/tickets・POST /api/tickets/[id]/comments でも
// 同じ判定を使うようにした。その集約先自体の単体テスト。

import { describe, expect, it } from 'vitest';
import { isSameOriginRequest } from '@/lib/csrf';

// テスト用リクエストを組み立てるヘルパー (headers を個別に渡せるようにする)
function makeRequest(headers: Record<string, string>): Request {
  return new Request('https://helpdesk.example.com/api/tickets', {
    method: 'POST',
    headers,
  });
}

describe('isSameOriginRequest', () => {
  // Sec-Fetch-Site が 'same-origin' なら許可する
  it('allows when Sec-Fetch-Site is same-origin', () => {
    expect(isSameOriginRequest(makeRequest({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
  });

  // Sec-Fetch-Site が 'cross-site' なら拒否する (別ドメインからの CSRF 攻撃)
  it('rejects when Sec-Fetch-Site is cross-site', () => {
    expect(isSameOriginRequest(makeRequest({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  // Sec-Fetch-Site が 'same-site' (同一 eTLD+1 の別オリジン) も許容しない
  it('rejects when Sec-Fetch-Site is same-site', () => {
    expect(isSameOriginRequest(makeRequest({ 'sec-fetch-site': 'same-site' }))).toBe(false);
  });

  // Sec-Fetch-Site が 'none' (ダイレクトナビゲーション) も拒否する
  it('rejects when Sec-Fetch-Site is none', () => {
    expect(isSameOriginRequest(makeRequest({ 'sec-fetch-site': 'none' }))).toBe(false);
  });

  // Sec-Fetch-Site が無い場合 (Safari 等) は Origin ヘッダで判定する: 一致すれば許可
  it('falls back to a matching Origin header when Sec-Fetch-Site is absent', () => {
    expect(isSameOriginRequest(makeRequest({ origin: 'https://helpdesk.example.com' }))).toBe(true);
  });

  // Origin ヘッダがサーバーのオリジンと異なれば拒否する
  it('rejects a mismatched Origin header', () => {
    expect(isSameOriginRequest(makeRequest({ origin: 'https://attacker.example.com' }))).toBe(
      false,
    );
  });

  // ブラウザが file:// 等から送る特殊な 'null' 文字列は同一オリジンと見なさない
  it('rejects the literal "null" Origin value', () => {
    expect(isSameOriginRequest(makeRequest({ origin: 'null' }))).toBe(false);
  });

  // Origin ヘッダが不正な URL 文字列なら fail-closed で拒否する
  it('rejects a malformed Origin header', () => {
    expect(isSameOriginRequest(makeRequest({ origin: 'not-a-valid-url' }))).toBe(false);
  });

  // Sec-Fetch-Site も Origin も無ければ fail-closed で拒否する
  it('rejects when neither Sec-Fetch-Site nor Origin is present', () => {
    expect(isSameOriginRequest(makeRequest({}))).toBe(false);
  });
});
