/**
 * Composition root for the email transport.
 *
 * Server-side code must obtain instances via `getEmailSender()` rather than
 * importing the adapters directly. The chosen adapter is decided by the
 * `EMAIL_DRIVER` env var:
 *
 *   - `console` (default in non-production): logs to stdout + outbox file
 *   - `smtp`: real Nodemailer SMTP transport (requires SMTP_* / EMAIL_FROM)
 *
 * The factory returns a singleton so that the Nodemailer transport (which
 * holds a pooled connection) is reused across server-action invocations.
 */
// EmailSender 契約
import type { EmailSender } from './email-sender';
// 各アダプタの生成関数
import { createConsoleEmailSender } from './console-email-sender';
import { createNodemailerEmailSender } from './nodemailer-email-sender';

// 公開する型 (外部コードは契約だけ参照すればよい)
export type { EmailMessage, EmailSender } from './email-sender';

// シングルトン参照を保持する変数 (1 度だけ生成して使い回す)
let cached: EmailSender | null = null;

// 現在のアプリで使う EmailSender を返すファクトリ関数
export function getEmailSender(): EmailSender {
  // 既に生成済みならそのまま返す
  if (cached) return cached;

  // 環境変数 EMAIL_DRIVER の値で実装を切り替える (未指定なら 'console')
  const driver = (process.env.EMAIL_DRIVER ?? 'console').toLowerCase();

  if (driver === 'smtp') {
    // SMTP 経路を選択する場合は接続情報が揃っていることを確認
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT ?? '587');
    const from = process.env.EMAIL_FROM;
    // 必須 (host / from) が無ければ起動を止める (誤設定で気付かず黙って失敗するより明示エラー)
    if (!host) throw new Error('EMAIL_DRIVER=smtp ですが SMTP_HOST が設定されていません');
    if (!from) throw new Error('EMAIL_DRIVER=smtp ですが EMAIL_FROM が設定されていません');
    // Nodemailer 実装を生成してキャッシュ
    cached = createNodemailerEmailSender({
      host,
      port,
      user: process.env.SMTP_USER,
      password: process.env.SMTP_PASSWORD,
      from,
    });
    return cached;
  }

  // 'console' またはそれ以外の値は Console 実装にフォールバックする
  cached = createConsoleEmailSender();
  return cached;
}

// テストや SIGHUP 風の再読み込みで明示的にキャッシュを破棄したいとき用
export function resetEmailSenderCache(): void {
  cached = null;
}
