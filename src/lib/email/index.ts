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

  // 環境変数 EMAIL_DRIVER の値で実装を切り替える (空文字も未指定扱い)
  const driver = process.env.EMAIL_DRIVER?.toLowerCase() || undefined;

  // CI / E2E など「production build (next start = NODE_ENV=production) で動かしたいが
  // 実メール送信ではなく outbox 経由で挙動を検証したい」シナリオ用の明示的オプトイン。
  // この escape hatch を使う側 (CI workflow など) は、自分で console を選んでいることを
  // 自覚しているとみなす。実本番では絶対に true にしないこと。
  const allowConsoleInProd = process.env.EMAIL_ALLOW_CONSOLE_IN_PROD === 'true';

  // 本番で driver 未指定 / 'smtp' 以外を選んでいる場合は起動時にエラーにする。
  // 設定漏れで「ユーザーには『メールを確認してください』が出るのに実メールは送られない」
  // という静かな壊れ方を防ぐため、明示的に SMTP 経路を要求する。
  // ただし上記の opt-in が明示されている場合だけは console での起動を許可する
  if (process.env.NODE_ENV === 'production' && driver !== 'smtp' && !allowConsoleInProd) {
    throw new Error(
      'production では EMAIL_DRIVER=smtp の明示設定が必要です ' +
        '(CI/E2E のように console を本番ビルドで使う場合は EMAIL_ALLOW_CONSOLE_IN_PROD=true を併設してください)',
    );
  }

  if (driver === 'smtp') {
    // SMTP 経路を選択する場合は接続情報が揃っていることを確認。
    // 文字列値は前後空白を除去してから空判定する: ".env で SMTP_HOST=' ' と書かれた場合に
    // 「未指定」扱いにする (空白だけの値が Nodemailer 段階で初めて壊れて分からないのを防ぐ)
    const host = process.env.SMTP_HOST?.trim() || undefined;
    // 既定ポートは STARTTLS 用の 587。?? は null/undefined しか拾わないので
    // 空文字や空白文字も未指定扱いにする (|| で trim 後にフォールバック)
    const port = Number(process.env.SMTP_PORT?.trim() || '587');
    const from = process.env.EMAIL_FROM?.trim() || undefined;
    // SMTP 認証情報も trim。空白だけの値は「未指定」と同じ扱いにする
    const smtpUser = process.env.SMTP_USER?.trim() || undefined;
    const smtpPassword = process.env.SMTP_PASSWORD?.trim() || undefined;
    // 必須 (host / from) が無ければ起動を止める (誤設定で気付かず黙って失敗するより明示エラー)
    if (!host) throw new Error('EMAIL_DRIVER=smtp ですが SMTP_HOST が設定されていません');
    if (!from) throw new Error('EMAIL_DRIVER=smtp ですが EMAIL_FROM が設定されていません');
    // SMTP_PORT が NaN / 0 / 負数 / 小数だと nodemailer に渡しても起動時には気付けず
    // 1 通目の send まで壊れていることが分からない。早期に検知する
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('SMTP_PORT は 1〜65535 の整数で指定してください');
    }
    // SMTP_USER と SMTP_PASSWORD は all-or-nothing。片方だけだと nodemailer が
    // 認証情報を無視して匿名 SMTP 接続にダウングレードし、認証要求環境で全 send が失敗する
    if ((smtpUser && !smtpPassword) || (!smtpUser && smtpPassword)) {
      throw new Error(
        'SMTP_USER と SMTP_PASSWORD は両方設定するか、両方とも空にしてください (片方だけは認証情報を黙って捨てる原因になります)',
      );
    }
    // Nodemailer 実装を生成してキャッシュ
    cached = createNodemailerEmailSender({
      host,
      port,
      user: smtpUser,
      password: smtpPassword,
      from,
    });
    return cached;
  }

  // 未知の driver 値は本番でなくとも明示的にエラーにする (タイポを silent に通さない)
  if (driver !== undefined && driver !== 'console') {
    throw new Error(`未対応の EMAIL_DRIVER 値です: ${driver} (許容値: console / smtp)`);
  }

  // dev/test 既定: Console 実装を生成してキャッシュ
  cached = createConsoleEmailSender();
  return cached;
}

// テストや SIGHUP 風の再読み込みで明示的にキャッシュを破棄したいとき用
export function resetEmailSenderCache(): void {
  cached = null;
}
