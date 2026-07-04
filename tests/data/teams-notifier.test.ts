// Teams 通知 Adapter (createTeamsNotifier) の単体テスト。
// Adaptive Card 形式のペイロード生成・Markdown インジェクション対策・HTTP エラー処理を検証する。
// 外部 API は呼ばず global.fetch をモックする (純粋なアダプタロジックのみ検証)。

// Vitest の DSL とフック
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// テスト対象: Teams 通知 Adapter のファクトリ
import { createTeamsNotifier } from '@/data/adapters/teams/teams-notifier';

// src/lib/webhook-fetch.ts は SSRF 対策の DNS 検証用 Dispatcher (Agent) を使うため
// undici の fetch を直接 import している。vi.stubGlobal('fetch', ...) だけでは差し替わらない
// ため、undici の fetch を globalThis.fetch (下の beforeEach で差し替える) へ委譲するモックにする
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: ((...args: Parameters<typeof globalThis.fetch>) =>
      globalThis.fetch(...args)) as unknown as typeof actual.fetch,
  };
});

// モックする Webhook URL (実際には送信されない)
const WEBHOOK_URL = 'https://example.webhook.office.com/webhookb2/abc';

// fetch のモック関数 (各テストで差し替える)
let fetchMock: ReturnType<typeof vi.fn>;

// HTTP レスポンスのモックを作るヘルパー (ok / status / 本文を指定)
function mockResponse(ok: boolean, status: number, body = '', type?: string) {
  return { ok, status, type, text: () => Promise.resolve(body) };
}

describe('createTeamsNotifier', () => {
  // 各テスト前に global.fetch を成功レスポンスを返すモックに差し替える
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(mockResponse(true, 200, ''));
    vi.stubGlobal('fetch', fetchMock);
  });

  // テスト後にモックを元に戻す
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 正常系: Adaptive Card 形式のペイロードを正しい URL に POST する
  it('Adaptive Card 形式で Webhook URL に POST する', async () => {
    // Teams 通知 Adapter を生成する
    const notifier = createTeamsNotifier(WEBHOOK_URL);
    // メッセージを送信する
    await notifier.send({ subject: '件名', body: '本文', ticketUrl: 'https://app/t/1' });

    // fetch が 1 回呼ばれ、URL とメソッドが正しいことを確認する
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');

    // 送信ボディを JSON としてパースして Adaptive Card 構造を検証する
    const payload = JSON.parse(init.body);
    expect(payload.type).toBe('message');
    expect(payload.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(payload.attachments[0].content.type).toBe('AdaptiveCard');
    // 件名・本文が TextBlock として含まれる
    const texts = payload.attachments[0].content.body.map((b: { text: string }) => b.text);
    expect(texts).toContain('件名');
    expect(texts).toContain('本文');
    // ticketUrl があれば Action.OpenUrl が付く
    expect(payload.attachments[0].content.actions[0].type).toBe('Action.OpenUrl');
    expect(payload.attachments[0].content.actions[0].url).toBe('https://app/t/1');
  });

  // セキュリティ: Markdown リンク記法を無害化してフィッシングリンクを無効化する
  it('Markdown リンク記法を全角括弧で無害化する', async () => {
    const notifier = createTeamsNotifier(WEBHOOK_URL);
    // 悪意あるユーザーがタイトルに Markdown リンクを仕込んだケース
    await notifier.send({ subject: '[クリック](http://evil.example)', body: '通常本文' });

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const subjectText = payload.attachments[0].content.body[0].text;
    // 角括弧が全角化され、生のリンク記法 [label](url) が成立しないこと
    expect(subjectText).toContain('［');
    expect(subjectText).toContain('］');
    expect(subjectText).not.toContain('](http');
  });

  // ticketUrl が無いときは actions を含めない
  it('ticketUrl が無ければ actions を省略する', async () => {
    const notifier = createTeamsNotifier(WEBHOOK_URL);
    await notifier.send({ subject: '件名', body: '本文' });

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    // actions プロパティが存在しないこと
    expect(payload.attachments[0].content.actions).toBeUndefined();
  });

  // 異常系: HTTP エラー (4xx/5xx) のとき例外を投げる
  it('HTTP エラー時は例外を投げる', async () => {
    // 400 を返すモックに差し替える
    fetchMock.mockResolvedValue(mockResponse(false, 400, 'Bad Request'));
    const notifier = createTeamsNotifier(WEBHOOK_URL);
    // 送信が reject されること
    await expect(notifier.send({ subject: 'x', body: 'y' })).rejects.toThrow(
      /Teams Webhook 送信失敗/,
    );
  });

  // SSRF 防御: リダイレクト応答 (opaqueredirect) は追従せず例外を投げる
  it('リダイレクト応答を拒否する', async () => {
    // redirect: 'manual' 時のリダイレクト応答を模したモックに差し替える
    fetchMock.mockResolvedValue(mockResponse(false, 0, '', 'opaqueredirect'));
    const notifier = createTeamsNotifier(WEBHOOK_URL);
    // リダイレクト先は未検証ホストへ抜ける恐れがあるため SSRF 対策で拒否される
    await expect(notifier.send({ subject: 'x', body: 'y' })).rejects.toThrow(/SSRF/);
  });
});
