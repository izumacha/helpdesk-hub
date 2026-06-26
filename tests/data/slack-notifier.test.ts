// Slack 通知 Adapter (createSlackNotifier) の単体テスト。
// Block Kit ペイロード生成・mrkdwn インジェクション対策・HTTP/アプリエラー処理・
// SSRF リダイレクト拒否を検証する。外部 API は呼ばず global.fetch をモックする。

// Vitest の DSL とフック
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// テスト対象: Slack 通知 Adapter のファクトリ
import { createSlackNotifier } from '@/data/adapters/slack/slack-notifier';

// モックする Webhook URL (実際には送信されない)
const WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/xxx';

// fetch のモック関数 (各テストで差し替える)
let fetchMock: ReturnType<typeof vi.fn>;

// HTTP レスポンスのモックを作るヘルパー (ok / status / 本文 / type を指定)
function mockResponse(ok: boolean, status: number, body = 'ok', type?: string) {
  return { ok, status, type, text: () => Promise.resolve(body) };
}

describe('createSlackNotifier', () => {
  // 各テスト前に global.fetch を成功 ("ok") レスポンスのモックに差し替える
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(mockResponse(true, 200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);
  });

  // テスト後にモックを元に戻す
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 正常系: Block Kit 形式で Webhook URL に POST する
  it('Block Kit 形式で Webhook URL に POST する', async () => {
    const notifier = createSlackNotifier(WEBHOOK_URL);
    await notifier.send({ subject: '件名', body: '本文', ticketUrl: 'https://app/t/1' });

    // fetch が 1 回呼ばれ、URL とメソッドが正しいことを確認する
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');

    // 送信ボディを JSON としてパースして Block Kit 構造を検証する
    const payload = JSON.parse(init.body);
    // 件名は header ブロック (plain_text) で表示される — mrkdwn の *...* ではなくなった
    const subjectBlock = payload.blocks[0];
    expect(subjectBlock.type).toBe('header');
    expect(subjectBlock.text.type).toBe('plain_text');
    expect(subjectBlock.text.text).toBe('件名');
    // 本文は section の plain_text ブロックで表示される
    const texts = payload.blocks.map((b: { text?: { text: string } }) => b.text?.text);
    expect(texts).toContain('本文');
    // ticketUrl があれば mrkdwn のリンク記法が含まれる (system-generated URL は plain_text 対象外)
    expect(texts.some((t: string | undefined) => t?.includes('https://app/t/1'))).toBe(true);
  });

  // セキュリティ: mrkdwn のリンク記法 (< と >) を HTML エンティティに無害化する
  it('mrkdwn の山括弧を無害化する', async () => {
    const notifier = createSlackNotifier(WEBHOOK_URL);
    // 悪意あるユーザーが本文に <http://evil|link> を仕込んだケース
    await notifier.send({ subject: '件名', body: '<http://evil|クリック>' });

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const bodyText = payload.blocks[2].text.text;
    // 生の山括弧が残らず &lt; / &gt; に変換されていること
    expect(bodyText).not.toContain('<http');
    expect(bodyText).toContain('&lt;');
  });

  // 異常系: HTTP エラー (4xx/5xx) のとき例外を投げる
  it('HTTP エラー時は例外を投げる', async () => {
    fetchMock.mockResolvedValue(mockResponse(false, 500, 'Server Error'));
    const notifier = createSlackNotifier(WEBHOOK_URL);
    await expect(notifier.send({ subject: 'x', body: 'y' })).rejects.toThrow(/Slack Webhook 送信失敗/);
  });

  // 異常系: HTTP 200 でもアプリレベルエラー (本文が "ok" 以外) なら例外を投げる
  it('本文が ok 以外なら例外を投げる', async () => {
    fetchMock.mockResolvedValue(mockResponse(true, 200, 'invalid_payload'));
    const notifier = createSlackNotifier(WEBHOOK_URL);
    await expect(notifier.send({ subject: 'x', body: 'y' })).rejects.toThrow(/Slack Webhook 送信失敗/);
  });

  // SSRF 防御: リダイレクト応答 (opaqueredirect) は追従せず例外を投げる
  it('リダイレクト応答を拒否する', async () => {
    fetchMock.mockResolvedValue(mockResponse(false, 0, '', 'opaqueredirect'));
    const notifier = createSlackNotifier(WEBHOOK_URL);
    await expect(notifier.send({ subject: 'x', body: 'y' })).rejects.toThrow(/SSRF/);
  });
});
