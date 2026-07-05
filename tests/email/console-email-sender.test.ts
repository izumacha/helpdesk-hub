// Vitest のテスト DSL (vi はスパイ/モック用)
import { describe, expect, it, vi } from 'vitest';
// Node 標準のファイル操作 (一時ファイルを read / delete する)
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// テスト対象
import { createConsoleEmailSender } from '@/lib/email/console-email-sender';

// 一時ファイル置き場 (テストごとに別の outbox を使ってレース回避)
function tempOutbox(): string {
  // OS の tmpdir 内に乱数付きファイル名を作る
  return path.join(tmpdir(), `magic-link-outbox-${Math.random().toString(36).slice(2)}.jsonl`);
}

describe('createConsoleEmailSender', () => {
  // EMAIL_DRIVER=console を選んだ時点で opt-in 扱い: outbox に 1 行 JSON が追記されること
  // (NODE_ENV による条件分岐は持たない。CI E2E が next start = NODE_ENV=production で
  //  動くが、E2E は outbox から URL を抽出する必要があるため)
  it('outbox に 1 行 JSON を追記する', async () => {
    // 専用の一時ファイルを使う sender を生成
    const outboxPath = tempOutbox();
    const sender = createConsoleEmailSender({ outboxPath });

    try {
      // 1 件送信
      await sender.send({
        to: 'tester@example.com',
        subject: 'ログインリンク',
        html: '<p>リンク</p>',
        text: 'リンク',
      });
      // ファイルが作成されていること
      expect(existsSync(outboxPath)).toBe(true);
      // 1 行 JSON として読めること
      const content = readFileSync(outboxPath, 'utf8').trim();
      const parsed = JSON.parse(content);
      // 主要フィールドが含まれていること
      expect(parsed.to).toBe('tester@example.com');
      expect(parsed.subject).toBe('ログインリンク');
      expect(parsed.sentAt).toBeTypeOf('string');
    } finally {
      // 後片付け
      if (existsSync(outboxPath)) rmSync(outboxPath);
    }
  });

  // 2 件以上の送信は追記され、JSON Lines として行ごとに読めること
  it('複数件は JSON Lines として追記される', async () => {
    const outboxPath = tempOutbox();
    const sender = createConsoleEmailSender({ outboxPath });

    try {
      // 2 件送信
      await sender.send({ to: 'a@example.com', subject: 's1', html: 'h', text: 't' });
      await sender.send({ to: 'b@example.com', subject: 's2', html: 'h', text: 't' });
      // ファイル全体を行ごとに解析
      const lines = readFileSync(outboxPath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      // 行 1 と 2 が想定どおりの to を持つこと
      expect(JSON.parse(lines[0]).to).toBe('a@example.com');
      expect(JSON.parse(lines[1]).to).toBe('b@example.com');
    } finally {
      if (existsSync(outboxPath)) rmSync(outboxPath);
    }
  });

  // マジックリンク本文には未消費のトークンを含む URL が入るため、stdout ログにはそれを出さないこと
  it('stdout ログに本文 (マジックリンク URL 等の機微情報) を出力しない', async () => {
    const outboxPath = tempOutbox();
    const sender = createConsoleEmailSender({ outboxPath });
    // console.log をスパイして実際の出力内容を検証する
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const secretUrl =
        'http://localhost:3000/api/auth/magic-link/callback?token=super-secret-token';
      await sender.send({
        to: 'tester@example.com',
        subject: 'ログインリンク',
        html: `<a href="${secretUrl}">link</a>`,
        text: `リンク\n\n${secretUrl}`,
      });

      // console.log に渡された全引数を文字列化して連結し、トークンを含む URL が含まれないことを確認する
      const loggedText = logSpy.mock.calls.map((args) => JSON.stringify(args)).join('\n');
      expect(loggedText).not.toContain('super-secret-token');
      expect(loggedText).not.toContain(secretUrl);
      // to/subject は引き続き stdout に出ていること (dev での目視確認に必要)
      expect(loggedText).toContain('tester@example.com');
      expect(loggedText).toContain('ログインリンク');
    } finally {
      logSpy.mockRestore();
      if (existsSync(outboxPath)) rmSync(outboxPath);
    }
  });
});
