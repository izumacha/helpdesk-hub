// isSameOriginRequest (同一オリジン検証ヘルパー) の仕様確認テスト。
// /code-review ultra 指摘対応: magic-link/callback に個別実装されていた CSRF 判定ロジックを
// src/lib/csrf.ts に集約し、POST /api/tickets・POST /api/tickets/[id]/comments でも
// 同じ判定を使うようにした。その集約先自体の単体テスト。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSameOriginRequest } from '@/lib/csrf';

// テスト用リクエストを組み立てるヘルパー (headers を個別に渡せるようにする)
function makeRequest(headers: Record<string, string>): Request {
  return new Request('https://helpdesk.example.com/api/tickets', {
    method: 'POST',
    headers,
  });
}

// リバースプロキシ配下を模したリクエストを組み立てるヘルパー。
// TLS 終端プロキシの内側では request.url が http://<内部ホスト> になる点を再現する
function makeProxiedRequest(headers: Record<string, string>): Request {
  return new Request('http://app-internal:3000/api/tickets', {
    method: 'POST',
    headers,
  });
}

// 各テストで stub した環境変数 (NEXTAUTH_URL 等) を必ず元に戻す (テスト間の独立性を確保)
afterEach(() => {
  vi.unstubAllEnvs();
});

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

// リバースプロキシ配下の Origin フォールバック判定 (フォローアップ 2026-07-22):
// TLS 終端プロキシの内側では request.url が http://<内部ホスト> になる一方、ブラウザは公開側の
// https://... を Origin ヘッダに載せるため、request.url とだけ比較すると Sec-Fetch-Site を
// 送らない正規クライアント (Safari 等) が 403 で誤拒否される。
// NEXTAUTH_URL 由来の信頼済みアプリオリジン (resolveAppBaseUrl) との一致も許可する修正の回帰テスト。
describe('isSameOriginRequest (リバースプロキシ配下の Origin フォールバック)', () => {
  // Origin が NEXTAUTH_URL の公開オリジンと一致すれば、request.url が内部オリジンでも許可する
  it('allows an Origin matching the configured app base URL behind a proxy', () => {
    // 公開側のアプリ URL を NEXTAUTH_URL として設定する
    vi.stubEnv('NEXTAUTH_URL', 'https://helpdesk.example.com');
    // 内部オリジン (http://app-internal:3000) へのリクエストに公開オリジンの Origin が付くケース
    expect(
      isSameOriginRequest(makeProxiedRequest({ origin: 'https://helpdesk.example.com' })),
    ).toBe(true);
  });

  // NEXTAUTH_URL を設定していても、どちらのオリジンとも一致しない Origin は引き続き拒否する
  it('still rejects a mismatched Origin even when the app base URL is configured', () => {
    // 公開側のアプリ URL を NEXTAUTH_URL として設定する
    vi.stubEnv('NEXTAUTH_URL', 'https://helpdesk.example.com');
    // 攻撃者オリジンは request.url とも NEXTAUTH_URL とも一致しないため拒否される
    expect(
      isSameOriginRequest(makeProxiedRequest({ origin: 'https://attacker.example.com' })),
    ).toBe(false);
  });

  // request.url のオリジンと一致する場合は NEXTAUTH_URL の設定に関わらず従来どおり許可する
  it('keeps allowing an Origin matching the request URL origin', () => {
    // 公開側のアプリ URL を NEXTAUTH_URL として設定する
    vi.stubEnv('NEXTAUTH_URL', 'https://helpdesk.example.com');
    // 直接アクセス (プロキシなし) のケース: request.url のオリジンとの一致で許可される
    expect(isSameOriginRequest(makeRequest({ origin: 'https://helpdesk.example.com' }))).toBe(true);
  });

  // NEXTAUTH_URL が不正形式で resolveAppBaseUrl が例外を投げても、request.url との一致は許可される
  // (アプリオリジン解決の失敗が正規の直接アクセスを壊さない = 従来動作への縮退)
  it('falls back to request URL matching when the app base URL is malformed', () => {
    // 不正な形式の NEXTAUTH_URL (URL パースで例外になる値)
    vi.stubEnv('NEXTAUTH_URL', 'not-a-valid-url');
    // request.url のオリジンと一致するので許可される
    expect(isSameOriginRequest(makeRequest({ origin: 'https://helpdesk.example.com' }))).toBe(true);
  });

  // NEXTAUTH_URL が不正形式のときにオリジン不一致なら fail-closed で拒否する
  // (アプリオリジンが解決できないからといって許可を広げない)
  it('rejects a mismatched Origin when the app base URL cannot be resolved (fail-closed)', () => {
    // 不正な形式の NEXTAUTH_URL (URL パースで例外になる値)
    vi.stubEnv('NEXTAUTH_URL', 'not-a-valid-url');
    // どちらのオリジンとも突合できないため拒否される
    expect(
      isSameOriginRequest(makeProxiedRequest({ origin: 'https://helpdesk.example.com' })),
    ).toBe(false);
  });

  // production で NEXTAUTH_URL 未設定 (resolveAppBaseUrl が throw) でも判定自体はクラッシュせず、
  // 従来どおり request.url との比較のみで fail-closed に拒否する
  it('does not crash and stays fail-closed when NEXTAUTH_URL is unset in production', () => {
    // 本番相当の環境で NEXTAUTH_URL を未設定にする (resolveAppBaseUrl は例外を投げる)
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXTAUTH_URL', '');
    // 例外を握って null 扱いにするため、判定は例外なく false になる
    expect(
      isSameOriginRequest(makeProxiedRequest({ origin: 'https://helpdesk.example.com' })),
    ).toBe(false);
  });
});
