/**
 * Provider-neutral contract for sending an outbound email.
 *
 * Used by magic-link auth in this PR; will be reused by Phase 2 features
 * (notification emails, auto-reply on Closed, inbound email parsing follow-ups).
 *
 * Adapters live in `./console-email-sender.ts` and `./nodemailer-email-sender.ts`.
 * Application code must only obtain instances via `getEmailSender()` from `./index`.
 */
// 送信 1 件分のメッセージ。HTML / Text どちらも必須にして、受信側クライアント差を吸収する
export interface EmailMessage {
  to: string; // 宛先メールアドレス (1 件)
  subject: string; // 件名 (日本語想定)
  html: string; // HTML 本文 (リッチ表示用)
  text: string; // テキスト本文 (HTML 非対応クライアント用フォールバック)
  // 任意: このメールに付与する Message-ID (山括弧込み "<...>")。
  // Phase 2 スレッド継続で、依頼者がこのメールに返信したとき In-Reply-To で元チケットへ
  // 紐付けられるよう、呼び出し側が決定的な Message-ID を指定して送る。未指定なら送信側に委ねる。
  messageId?: string;
}

// 任意のトランスポート (Console / Nodemailer SMTP / 将来の SES など) を抽象化する契約
export interface EmailSender {
  // 1 件のメッセージを送信する。失敗時は例外を投げる (呼び出し側はキャッチ要)
  send(message: EmailMessage): Promise<void>;
}
