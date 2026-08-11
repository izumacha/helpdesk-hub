// エラー応答から画面用メッセージを取り出す共通ヘルパーの単体テスト。
// 新規起票フォームとコメント投稿フォームが同じ手順を共有するため、優先順位と
// 「壊れた応答でも文字列しか返さない」性質をここで固定する。

// Vitest の DSL
import { afterEach, describe, expect, it, vi } from 'vitest';
// 検証対象
import { readApiErrorMessage } from '@/lib/api-error-message';

// テスト用の共通引数 (既定文言とログ識別子)
const OPTIONS = { fallbackMessage: '送信に失敗しました', logPrefix: '[Test]' } as const;

// JSON 本文を持つエラー応答を組み立てるヘルパー
function jsonResponse(body: unknown, status = 422): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  // console.error のスパイをテストごとに戻す (他のテストの出力を汚さない)
  vi.restoreAllMocks();
});

describe('readApiErrorMessage', () => {
  // issues[0].message が最優先 (添付検証の 422 が「どう直すか」を書いているのはこちら)
  it('prefers issues[0].message over error', async () => {
    const res = jsonResponse({
      error: '入力値が正しくありません',
      issues: [{ message: '1 ファイルあたり 10.0MB までです' }],
    });
    await expect(readApiErrorMessage(res, OPTIONS)).resolves.toBe(
      '1 ファイルあたり 10.0MB までです',
    );
  });

  // issues が無ければ error を使う
  it('falls back to error when issues is absent', async () => {
    const res = jsonResponse({ error: 'チケットが見つかりません' }, 404);
    await expect(readApiErrorMessage(res, OPTIONS)).resolves.toBe('チケットが見つかりません');
  });

  // どちらも無ければ呼び出し元の既定文言を使う
  it('falls back to the caller default when the body carries no message', async () => {
    const res = jsonResponse({}, 500);
    await expect(readApiErrorMessage(res, OPTIONS)).resolves.toBe('送信に失敗しました');
  });

  // 本文が JSON の null でも既定文言へ落ちる (null 参照で落ちない)
  it('handles a literal JSON null body', async () => {
    const res = jsonResponse(null, 500);
    await expect(readApiErrorMessage(res, OPTIONS)).resolves.toBe('送信に失敗しました');
  });

  // **文字列でない error / message は採用しない。**
  // そのまま返すと setState 経由で React の描画が落ち、画面が真っ白になる
  it('ignores a non-string error field instead of returning an object', async () => {
    const res = jsonResponse({ error: { code: 'ETIMEDOUT' } }, 504);
    const message = await readApiErrorMessage(res, OPTIONS);
    expect(typeof message).toBe('string');
    expect(message).toBe('送信に失敗しました');
  });

  // issues[0].message が文字列でない場合も同様に採用しない
  it('ignores a non-string issue message', async () => {
    const res = jsonResponse({ issues: [{ message: { ja: 'だめです' } }] }, 422);
    const message = await readApiErrorMessage(res, OPTIONS);
    expect(typeof message).toBe('string');
    expect(message).toBe('送信に失敗しました');
  });

  // JSON でない本文 (プロキシが返す HTML 等) はステータス番号を添えた文言へ落とし、
  // 解析できなかった理由はコンソールにだけ残す (画面には内部詳細を出さない)
  it('appends the status and logs when the body is not JSON', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = new Response('<html>502 Bad Gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    });
    await expect(readApiErrorMessage(res, OPTIONS)).resolves.toBe('送信に失敗しました (HTTP 502)');
    // ログ識別子付きで 1 行残っていること
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain('[Test]');
  });
});
