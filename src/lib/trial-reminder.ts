/**
 * Free trial expiry reminder helpers (pure logic / email rendering — no I/O).
 *
 * docs/smb-dx-pivot-plan.md §7.2「30日間の Free trial (Standard 相当)」フォローアップ。
 * 監査で発見したギャップ: トライアル残日数の計算自体は既に settings/page.tsx にあるが、
 * それは管理者が /settings を自ら開いたときにしか表示されない。定期実行のリマインダー
 * (メール送信) が無いため、管理者が気づかないまま Free へ自動降格される事故を防ぐために追加する。
 *
 * すべて副作用のない純粋関数なのでユニットテスト (tests/trial-reminder.test.ts) で網羅できる。
 * 実際の一覧取得・送信は呼び出し側 (POST /api/internal/trial-reminders) が担う。
 */

// HTML 本文に外部由来文字列 (テナント名) を差し込む前のエスケープ (共有ヘルパーを再利用)
import { escapeHtml } from '@/lib/html-escape';

// リマインダーを送る「終了何日前」の一覧。1 日 1 回の定期実行 (cron) を前提に、
// ここに列挙した日数とちょうど一致した日だけ送信することで、送信済みフラグを
// DB に持たなくても二重送信を防げる (cron が確実に毎日 1 回動く前提の設計)
export const TRIAL_REMINDER_DAYS_BEFORE = [5, 1] as const;

// 内部一覧取得の上限件数 (§8 一覧取得は必ず上限を持たせる)。SMB 向け SaaS の想定規模
// (数百テナント程度) では 1 回の cron 実行で十分に収まる件数
export const TRIAL_REMINDER_QUERY_LIMIT = 500;

// trialEndsAt までの残り日数を計算する (settings/page.tsx の trialDaysRemaining と同じ丸め方: 切り上げ)。
// 負値 (既に終了済み) もそのまま返す ― 呼び出し側で正の値かどうかを判定する
export function daysUntilTrialEnds(trialEndsAt: Date, now: Date): number {
  return Math.ceil((trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

// 「今日がちょうどリマインダー送信日か」を判定する。TRIAL_REMINDER_DAYS_BEFORE に
// 列挙した日数のいずれかと残り日数が一致するときだけ true を返す
export function shouldSendTrialReminder(trialEndsAt: Date, now: Date): boolean {
  const daysRemaining = daysUntilTrialEnds(trialEndsAt, now);
  return (TRIAL_REMINDER_DAYS_BEFORE as readonly number[]).includes(daysRemaining);
}

// トライアル終了リマインダーメールの本文を組み立てる純粋関数 (副作用なし)
export function renderTrialReminderEmail(input: {
  tenantName: string; // 組織名 (メール本文の宛先識別に使う)
  daysRemaining: number; // 残り日数 (TRIAL_REMINDER_DAYS_BEFORE のいずれか)
  settingsUrl: string; // 課金プランを確認・アップグレードできる設定画面 URL
}): { subject: string; text: string; html: string } {
  // 残り日数に応じて文言を出し分ける (1日前は「明日」、それ以外は「あとN日」)
  const daysLabel = input.daysRemaining === 1 ? '明日' : `あと${input.daysRemaining}日`;

  // 件名 (受信箱で内容が分かるように残り日数を明記する)
  const subject = `[HelpDesk Hub] 無料トライアルの終了まで${daysLabel}です`;

  // テキスト本文 (HTML 非対応クライアント向けフォールバック)
  const text = [
    `${input.tenantName} 様`,
    '',
    `ご利用中の無料トライアル (Standard 相当) は、終了まで${daysLabel}となりました。`,
    'トライアル終了後は自動的に Free プランに切り替わり、メール取り込みなど一部機能が',
    'ご利用いただけなくなります。',
    '',
    '引き続きご利用いただくには、下記の設定画面からプランをお選びください。',
    `${input.settingsUrl}`,
    '',
    'このメールに心当たりがない場合は破棄してください。',
  ].join('\n');

  // HTML 本文に差し込む外部由来文字列 (テナント名・URL) を個別にエスケープする (XSS 防止)
  const escapedTenantName = escapeHtml(input.tenantName);
  const escapedUrl = escapeHtml(input.settingsUrl);

  const html = `
    <p>${escapedTenantName} 様</p>
    <p>ご利用中の無料トライアル (Standard 相当) は、終了まで${daysLabel}となりました。</p>
    <p>トライアル終了後は自動的に Free プランに切り替わり、メール取り込みなど一部機能が
    ご利用いただけなくなります。</p>
    <p>引き続きご利用いただくには、下記の設定画面からプランをお選びください。</p>
    <p><a href="${escapedUrl}" style="display:inline-block;padding:10px 16px;background:#0f766e;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600;">プランを確認する</a></p>
    <p style="font-size:13px;color:#475569;">うまく開けない場合はこちらの URL をブラウザに貼り付けてください:<br><span style="word-break:break-all;">${escapedUrl}</span></p>
    <p style="font-size:13px;color:#64748b;">このメールに心当たりがない場合は破棄してください。</p>
  `.trim();

  return { subject, text, html };
}
