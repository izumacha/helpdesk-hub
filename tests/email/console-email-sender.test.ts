// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';
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
});
