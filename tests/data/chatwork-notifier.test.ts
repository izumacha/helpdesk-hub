// Chatwork 通知 Adapter (createChatworkNotifier) の単体テスト。
// REST API 呼び出し・認証ヘッダ・ルーム ID 検証・タグインジェクション対策・HTTP エラー処理を検証する。
// 外部 API は呼ばず global.fetch をモックする (純粋なアダプタロジックのみ検証)。

// Vitest の DSL とフック
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// テスト対象: Chatwork 通知 Adapter のファクトリ
import { createChatworkNotifier } from '@/data/adapters/chatwork/chatwork-notifier';

// テスト用の API トークンとルーム ID
const API_TOKEN = 'test-token-123';
const ROOM_ID = '12345678';

// fetch のモック関数 (各テストで差し替える)
let fetchMock: ReturnType<typeof vi.fn>;

// HTTP レスポンスのモックを作るヘルパー
function mockResponse(ok: boolean, status: number, body = '{"message_id":"1"}') {
  return { ok, status, text: () => Promise.resolve(body) };
}

describe('createChatworkNotifier', () => {
  // 各テスト前に global.fetch を成功レスポンスを返すモックに差し替える
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(mockResponse(true, 200));
    vi.stubGlobal('fetch', fetchMock);
  });

  // テスト後にモックを元に戻す
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 正常系: 正しい URL・認証ヘッダ・フォームボディで POST する
  it('Chatwork メッセージ API に認証ヘッダ付きで POST する', async () => {
    const notifier = createChatworkNotifier(API_TOKEN, ROOM_ID);
    await notifier.send({ subject: '件名', body: '本文', ticketUrl: 'https://app/t/1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // URL にルーム ID が埋め込まれている
    expect(url).toBe('https://api.chatwork.com/v2/rooms/12345678/messages');
    expect(init.method).toBe('POST');
    // 認証トークンが専用ヘッダに載っている
    expect(init.headers['X-ChatWorkToken']).toBe(API_TOKEN);
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    // フォームボディに件名・本文・チケット URL が含まれる
    const body = new URLSearchParams(init.body);
    const messageBody = body.get('body') ?? '';
    expect(messageBody).toContain('件名');
    expect(messageBody).toContain('本文');
    expect(messageBody).toContain('https://app/t/1');
  });

  // セキュリティ: ルーム ID が数字以外なら送信前に例外を投げる (パスインジェクション防止)
  it('数字以外のルーム ID は例外を投げ fetch を呼ばない', async () => {
    // パストラバーサルを狙った不正なルーム ID
    const notifier = createChatworkNotifier(API_TOKEN, '123/../../evil');
    await expect(notifier.send({ subject: 'x', body: 'y' })).rejects.toThrow(/ルーム ID/);
    // 不正値では外部リクエストが発行されないこと
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // セキュリティ: Chatwork タグ記法 ([To:] 等) を全角化して無効化する
  it('角括弧タグを全角化して無効化する', async () => {
    const notifier = createChatworkNotifier(API_TOKEN, ROOM_ID);
    // メンション偽装を狙ったユーザー入力
    await notifier.send({ subject: '[To:999]偽装', body: '本文' });

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    const messageBody = body.get('body') ?? '';
    // 半角 [To:999] が残っていないこと (全角 ［ ］ に置換されている)
    expect(messageBody).not.toContain('[To:999]');
    expect(messageBody).toContain('［To:999］');
  });

  // 異常系: HTTP エラー (認証失敗など) のとき例外を投げる
  it('HTTP エラー時は例外を投げる', async () => {
    fetchMock.mockResolvedValue(mockResponse(false, 401, 'Unauthorized'));
    const notifier = createChatworkNotifier(API_TOKEN, ROOM_ID);
    await expect(notifier.send({ subject: 'x', body: 'y' })).rejects.toThrow(/Chatwork API 送信失敗/);
  });
});
