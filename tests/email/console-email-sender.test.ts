// Vitest のテスト DSL + 環境変数スタブ
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  // 各テスト終了後に環境変数スタブを必ず巻き戻す
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // 非本番では outbox ファイルに 1 行 JSON が追記されること
  it('非本番では outbox に 1 行 JSON を追記する', async () => {
    // NODE_ENV を 'development' に切り替える (vi.stubEnv は read-only 型を回避できる)
    vi.stubEnv('NODE_ENV', 'development');

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

  // 本番では outbox に書き出さないこと
  it('本番 (NODE_ENV=production) では outbox を作成しない', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const outboxPath = tempOutbox();
    const sender = createConsoleEmailSender({ outboxPath });

    // 1 件送信
    await sender.send({
      to: 'a@example.com',
      subject: 's',
      html: 'h',
      text: 't',
    });
    // ファイルが作成されていないこと
    expect(existsSync(outboxPath)).toBe(false);
  });
});
