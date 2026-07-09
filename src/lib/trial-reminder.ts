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

// リマインダーを送る「終了何日前」マイルストーンの一覧 (緊急度の低い順)。
// Tenant.trialReminderLastSentDaysBefore (直近に送信済みのマイルストーン) と組み合わせて
// resolveTrialReminderMilestone が「今回送るべきマイルストーン」を決める。
// /code-review ultra 指摘対応: 当初は「ちょうど一致した日だけ送る」設計だったが、
// GitHub Actions の cron は手動再実行 (workflow_dispatch) で同日に複数回走ったり、
// 遅延・欠落でちょうどの日を通り過ぎたりしうるドキュメント化された既知の制約があるため、
// 「まだ送っていない最も緊急なマイルストーンに達していれば送る」方式に変更し、
// 送信済みマイルストーンを DB (Tenant.trialReminderLastSentDaysBefore) に永続化することで
// 二重送信・取りこぼしの両方を防ぐ。
export const TRIAL_REMINDER_DAYS_BEFORE = [5, 1] as const;

// 内部一覧取得の上限件数 (§8 一覧取得は必ず上限を持たせる)。SMB 向け SaaS の想定規模
// (数百テナント程度) では 1 回の cron 実行で十分に収まる件数
export const TRIAL_REMINDER_QUERY_LIMIT = 500;

// UTC 暦日 (時刻成分を切り捨てた「その日の 00:00 UTC」) をミリ秒で返す内部ヘルパー。
// /code-review ultra 指摘対応: 連続時間の差分 (ms) をそのまま丸めると、cron の実行時刻が
// 日によって数時間ずれただけで残り日数の整数値が「5 → 3」のように 1 つ以上飛んでしまい、
// ちょうど 5 日/1 日を狙う shouldSendTrialReminder が対象日を取りこぼしうる (GitHub Actions の
// スケジュール実行は数分〜数時間遅延することがあるドキュメント化された既知の制約)。
// 両方の日時を暦日 (UTC) に丸めてから差分を取ることで、同じ日のどの時刻に cron が実行されても
// 常に同じ結果になるようにする (取りこぼしリスクを「日をまたぐ遅延」だけに限定する)。
function toUtcDateOnlyMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// trialEndsAt までの残り暦日数 (UTC 基準) を計算する。
// 負値 (既に終了済み) もそのまま返す ― 呼び出し側で正の値かどうかを判定する
export function daysUntilTrialEnds(trialEndsAt: Date, now: Date): number {
  return Math.round((toUtcDateOnlyMs(trialEndsAt) - toUtcDateOnlyMs(now)) / (24 * 60 * 60 * 1000));
}

// 「今回送るべきマイルストーン」を決める。まだ送っていない (lastSentDaysBefore より小さい)
// マイルストーンのうち、残り日数がその閾値以下になっているものの中から最も緊急な
// (= 数値が最小の) ものを 1 つ返す。無ければ null (今回は何も送らない)。
//
// この方式により:
// - 通常の 1 日 1 回実行: daysRemaining が 5 に達した日に「5」を送信 (以降 5 は再送しない)。
// - cron の遅延・欠落で「5」の日をまるごと飛ばした場合: 次に実行されたとき daysRemaining が
//   例えば 3 でも「5」がまだ未送信 (lastSentDaysBefore=null) なので、実際の残り日数 (3) を
//   本文に含めた形で「5」マイルストーンとして遅れて送信できる (取りこぼし防止)。
// - workflow_dispatch の手動再実行で同日に 2 回叩かれた場合: 1 回目で lastSentDaysBefore が
//   更新済みのため、2 回目は同じマイルストーンを再度満たさず null を返す (二重送信防止)。
//
// 既知の制約 (/code-review ultra 指摘): cron が非常に長時間 (5 日以上) 停止し、未送信のまま
// daysRemaining が 5 と 1 の両方を一度に通り過ぎた場合、最も緊急な「1」だけを送り「5」は送らない
// (Math.min で最小値を選ぶため)。これは意図的な選択: 「5」を今さら送っても実際の残り日数と
// 乖離した古い内容になり誤解を招くため、常に正確な残り日数を伴う最も緊急な通知を優先する。
// GitHub Actions の cron 遅延は通常「分〜時間」単位であり、この状況 (5 日以上の完全停止) は
// 極めて起こりにくいことを踏まえたトレードオフ
export function resolveTrialReminderMilestone(
  daysRemaining: number,
  lastSentDaysBefore: number | null,
): number | null {
  // 残り日数がその閾値以下、かつまだ送っていない (閾値 < 直近送信済み、または未送信) の
  // マイルストーンだけを候補として集める
  const candidates = (TRIAL_REMINDER_DAYS_BEFORE as readonly number[]).filter(
    (threshold) =>
      daysRemaining <= threshold && (lastSentDaysBefore === null || threshold < lastSentDaysBefore),
  );
  // 候補が無ければ今回は送らない
  if (candidates.length === 0) return null;
  // 最も緊急な (数値が最小の) マイルストーンを選ぶ
  return Math.min(...candidates);
}

// トライアル終了リマインダーメールの本文を組み立てる純粋関数 (副作用なし)
export function renderTrialReminderEmail(input: {
  tenantName: string; // 組織名 (メール本文の宛先識別に使う)
  // 実際の残り日数 (daysUntilTrialEnds の戻り値をそのまま渡す。マイルストーン取りこぼし後の
  // 遅延送信では TRIAL_REMINDER_DAYS_BEFORE のいずれとも一致しない実際の値になりうるため、
  // 本文には常に正確な残り日数を表示する)
  daysRemaining: number;
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
