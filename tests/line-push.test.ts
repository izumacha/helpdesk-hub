// LINE Messaging API push (src/lib/line-push.ts) の単体テスト。
// 本文組み立て (純粋関数) と push 送信 (副作用) を検証する。外部 API は呼ばず global.fetch をモックする。

// Vitest の DSL とフック
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// テスト対象: 本文組み立て / push 送信
import { buildTicketReplyLineMessage, pushLineMessage } from '@/lib/line-push';

// テスト用の有効な LINE ユーザー ID (正規形式: 'U' + 32 桁 16 進数)
const VALID_LINE_USER_ID = `U${'a'.repeat(32)}`;

describe('buildTicketReplyLineMessage', () => {
  // 正常系: 担当者名・件名・本文・URL が文面に含まれる
  it('担当者名・件名・本文・URL を含む文面を組み立てる', () => {
    const text = buildTicketReplyLineMessage({
      ticketTitle: 'PC が起動しない',
      ticketUrl: 'https://app.example.com/tickets/abc',
      commentBody: '電源ケーブルをご確認ください。',
      agentName: '田中',
    });
    expect(text).toContain('田中');
    expect(text).toContain('PC が起動しない');
    expect(text).toContain('電源ケーブルをご確認ください。');
    expect(text).toContain('https://app.example.com/tickets/abc');
  });

  // 境界値: LINE のテキストメッセージ上限 (5000 文字) を超える場合は末尾を省略する
  it('5000 文字を超える場合は末尾を省略する', () => {
    const longBody = 'あ'.repeat(6000);
    const text = buildTicketReplyLineMessage({
      ticketTitle: '件名',
      ticketUrl: 'https://app.example.com/tickets/abc',
      commentBody: longBody,
      agentName: '担当者',
    });
    expect(text.length).toBe(5000);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('pushLineMessage', () => {
  // fetch のモック関数 (各テストで差し替える)
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // 既定は成功レスポンス
    fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        type: 'basic',
        text: () => Promise.resolve('{}'),
      });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // 未設定: LINE_CHANNEL_ACCESS_TOKEN が無ければ何もせず fetch を呼ばない (任意機能のスキップ)
  it('LINE_CHANNEL_ACCESS_TOKEN 未設定なら fetch を呼ばない', async () => {
    vi.stubEnv('LINE_CHANNEL_ACCESS_TOKEN', '');
    await pushLineMessage(VALID_LINE_USER_ID, 'こんにちは');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // 正常系: Messaging API の push エンドポイントへ Bearer 認証付きで POST する
  it('Messaging API へ Bearer 認証付きで POST する', async () => {
    vi.stubEnv('LINE_CHANNEL_ACCESS_TOKEN', 'test-access-token');
    await pushLineMessage(VALID_LINE_USER_ID, 'こんにちは');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.line.me/v2/bot/message/push');
    expect(init.headers.Authorization).toBe('Bearer test-access-token');
    const body = JSON.parse(init.body);
    expect(body.to).toBe(VALID_LINE_USER_ID);
    expect(body.messages).toEqual([{ type: 'text', text: 'こんにちは' }]);
  });

  // セキュリティ: 不正な形式の lineUserId は fetch を呼ばずにスキップする (防御的な多層チェック)
  it('不正な形式の lineUserId は fetch を呼ばない', async () => {
    vi.stubEnv('LINE_CHANNEL_ACCESS_TOKEN', 'test-access-token');
    await pushLineMessage('not-a-line-user-id', 'こんにちは');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // 異常系: HTTP エラー時は例外を投げる (呼び出し側がベストエフォートとして catch する)
  it('HTTP エラー時は例外を投げる', async () => {
    vi.stubEnv('LINE_CHANNEL_ACCESS_TOKEN', 'test-access-token');
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      type: 'basic',
      text: () => Promise.resolve('Unauthorized'),
    });
    await expect(pushLineMessage(VALID_LINE_USER_ID, 'こんにちは')).rejects.toThrow(
      /LINE push 送信失敗/,
    );
  });
});
