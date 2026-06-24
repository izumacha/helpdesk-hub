// nodemailer の本体 (SMTP トランスポート提供)
import nodemailer, { type Transporter } from 'nodemailer';
// EmailSender 契約をインポート
import type { EmailMessage, EmailSender } from './email-sender';

/**
 * Configuration for the SMTP transport.
 *
 * Loaded from environment variables by `getEmailSender()`. Documented in
 * `.env.example`. The factory is responsible for validating that required
 * fields are present when `EMAIL_DRIVER=smtp`.
 */
// SMTP 接続に必要な設定値の集合
export interface NodemailerEmailSenderConfig {
  host: string; // SMTP サーバのホスト名
  port: number; // SMTP ポート (465=暗黙SSL, 587=STARTTLS など)
  user?: string; // 認証ユーザー名 (匿名 SMTP の場合は省略可)
  password?: string; // 認証パスワード
  from: string; // 既定の差出人ヘッダ (例: '"HelpDesk Hub" <no-reply@example.com>')
}

/**
 * Real SMTP adapter used in production. Authentication is sent only when both
 * user and password are configured (Mailhog and similar dev relays accept
 * unauthenticated connections, hence the conditional `auth` block).
 *
 * `secure: true` is auto-selected for port 465 per SMTP convention; other ports
 * use STARTTLS via nodemailer's defaults.
 */
// SMTP サーバへ実際に配送する本番用 EmailSender 実装
export function createNodemailerEmailSender(config: NodemailerEmailSenderConfig): EmailSender {
  // ポート 465 は暗黙の TLS を使うのが慣例 (それ以外は STARTTLS をライブラリ既定に任せる)
  const secure = config.port === 465;

  // 認証情報が両方揃っているときだけ auth ブロックを渡す (匿名 SMTP 対応)
  const auth =
    config.user && config.password ? { user: config.user, pass: config.password } : undefined;

  // Nodemailer トランスポートを 1 度だけ生成して使い回す
  const transporter: Transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure,
    auth,
  });

  return {
    // 実際にメールを送信する
    async send(message: EmailMessage) {
      // sendMail に EmailMessage の各フィールドを渡す (from は config の既定値)
      await transporter.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        // 指定があれば Message-ID を明示する (スレッド継続の紐付けに使う)。未指定なら nodemailer が自動採番
        messageId: message.messageId,
        // 任意の追加ヘッダ (例: Auto-Submitted: auto-replied) をそのまま付与する。未指定なら付けない
        headers: message.headers,
      });
    },
  };
}
