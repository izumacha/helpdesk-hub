// Webhook POST 共通ユーティリティ (postWebhook) の単体テスト。
// タイムアウト・本文上限読み取り・リダイレクト非追従 (SSRF 防御) を検証する。
// 外部 API は呼ばず global.fetch をモックする。

// Vitest の DSL とフック
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// テスト対象: Webhook POST 共通ユーティリティ
import { postWebhook } from '@/lib/webhook-fetch';

// fetch のモック関数 (各テストで差し替える)
let fetchMock: ReturnType<typeof vi.fn>;

// テスト用の送信先 URL とオプション
const URL = 'https://example.com/webhook';
const OPTIONS = {
  headers: { 'Content-Type': 'application/json' },
  body: '{"x":1}',
  timeoutMs: 5_000,
  maxResponseBytes: 1024,
};

// HTTP レスポンスのモックを作るヘルパー (type は redirect 判定用に任意指定)
function mockResponse(opts: {
  ok: boolean;
  status: number;
  body?: string;
  type?: string;
}) {
  return {
    ok: opts.ok,
    status: opts.status,
    type: opts.type,
    text: () => Promise.resolve(opts.body ?? ''),
  };
}

describe('postWebhook', () => {
  // 各テスト前に fetch を差し替える (既定は成功レスポンス)
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 200, body: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
  });

  // テスト後にモックを元に戻す
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 正常系: ステータス・本文をそのまま返し、redirect: 'manual' を必ず指定する
  it('成功レスポンスを返し redirect: manual を指定する', async () => {
    const result = await postWebhook(URL, OPTIONS);
    // HTTP の成否・ステータス・本文がそのまま返る
    expect(result).toEqual({ ok: true, status: 200, bodyText: 'ok' });
    // fetch に渡した init で SSRF 対策のリダイレクト非追従が有効になっている
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
  });

  // SSRF 防御: opaqueredirect (redirect: 'manual' 時のリダイレクト応答) を拒否する
  it('opaqueredirect 応答を拒否する', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 0, type: 'opaqueredirect' }));
    // リダイレクト応答は SSRF リスクとして例外になる
    await expect(postWebhook(URL, OPTIONS)).rejects.toThrow(/リダイレクト応答は SSRF 対策/);
  });

  // SSRF 防御: 3xx をそのまま返す実装でもリダイレクトとして拒否する
  it('3xx ステータスを拒否する', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 302, body: 'Found' }));
    await expect(postWebhook(URL, OPTIONS)).rejects.toThrow(/リダイレクト応答は SSRF 対策/);
  });

  // レスポンス本文を maxResponseBytes で切り詰める (巨大な本文を保持しない)
  it('本文を maxResponseBytes で切り詰める', async () => {
    // 上限を超える長い本文を返す
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, body: 'a'.repeat(5000) }));
    // 上限 10 バイトで読み取る
    const result = await postWebhook(URL, { ...OPTIONS, maxResponseBytes: 10 });
    // 10 文字に切り詰められている
    expect(result.bodyText).toBe('a'.repeat(10));
  });
});
