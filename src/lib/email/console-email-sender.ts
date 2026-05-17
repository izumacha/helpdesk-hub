// EmailSender 契約とメッセージ型をインポート
import type { EmailMessage, EmailSender } from './email-sender';
// ファイル書き出し用 (E2E がアウトボックスを読みやすくするため)
import { appendFileSync } from 'node:fs';
// プロジェクトルートからの相対パスを解決するため
import path from 'node:path';

/**
 * Console adapter: logs to stdout and appends a JSON line to
 * `.magic-link-outbox.jsonl` (project root, gitignored).
 *
 * Production usage is rejected — `getEmailSender()` selects this adapter
 * only when `EMAIL_DRIVER=console`. The outbox file write is additionally
 * skipped if `NODE_ENV === 'production'` to keep dev/test artifacts out of
 * any accidental prod deploy.
 *
 * The E2E suite reads the last JSON line of the outbox file to extract the
 * magic-link URL for assertion. No dev-only HTTP endpoint is exposed.
 */
// 開発/テスト用のメール送信実装。実際には送らず、標準出力と outbox ファイルに記録する
export function createConsoleEmailSender(options?: { outboxPath?: string }): EmailSender {
  // 既定の outbox パスはプロジェクトルート直下 (process.cwd() を起点に解決)
  const outboxPath = options?.outboxPath ?? path.join(process.cwd(), '.magic-link-outbox.jsonl');

  return {
    // 1 件のメッセージを「送ったことにする」実装
    async send(message: EmailMessage) {
      // 標準出力に整形ログを出す (dev で目視確認しやすくする)
      console.log('[email:console]', {
        to: message.to,
        subject: message.subject,
        textPreview: message.text.slice(0, 120),
      });

      // 本番環境では outbox ファイルへの書き出しを行わない (誤って prod 投入時の漏洩防止)
      if (process.env.NODE_ENV === 'production') return;

      // メッセージ全体を 1 行 JSON で append (E2E が末尾を読む想定)
      const line =
        JSON.stringify({
          sentAt: new Date().toISOString(), // 送信時刻
          ...message,
        }) + '\n';
      // 同期書き込みで E2E のレース回避 (件数が少ない dev/test のみ動作するため OK)
      appendFileSync(outboxPath, line, { encoding: 'utf8' });
    },
  };
}
