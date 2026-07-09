// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';
// テスト対象 (純粋ヘルパー)
import {
  daysUntilTrialEnds,
  shouldSendTrialReminder,
  renderTrialReminderEmail,
  TRIAL_REMINDER_DAYS_BEFORE,
} from '@/lib/trial-reminder';

describe('daysUntilTrialEnds', () => {
  // ちょうど 5 日後なら 5 を返す (切り上げ計算)
  it('残り日数をちょうどの日数で返す', () => {
    const now = new Date('2026-07-01T00:00:00Z');
    const trialEndsAt = new Date('2026-07-06T00:00:00Z');
    expect(daysUntilTrialEnds(trialEndsAt, now)).toBe(5);
  });

  // 端数がある場合は切り上げる (settings/page.tsx の trialDaysRemaining と同じ丸め方)
  it('端数は切り上げる', () => {
    const now = new Date('2026-07-01T00:00:00Z');
    // 4日と1時間後 → 切り上げで5
    const trialEndsAt = new Date('2026-07-05T01:00:00Z');
    expect(daysUntilTrialEnds(trialEndsAt, now)).toBe(5);
  });

  // 既に終了済みなら負値を返す (呼び出し側が判定に使う)
  it('終了済みの場合は負値を返す', () => {
    const now = new Date('2026-07-10T00:00:00Z');
    const trialEndsAt = new Date('2026-07-05T00:00:00Z');
    expect(daysUntilTrialEnds(trialEndsAt, now)).toBeLessThan(0);
  });
});

describe('shouldSendTrialReminder', () => {
  // TRIAL_REMINDER_DAYS_BEFORE に列挙された日数と一致する日は true
  it.each(TRIAL_REMINDER_DAYS_BEFORE)('残り%s日ちょうどのときは true を返す', (days) => {
    const now = new Date('2026-07-01T00:00:00Z');
    const trialEndsAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    expect(shouldSendTrialReminder(trialEndsAt, now)).toBe(true);
  });

  // リマインダー対象日以外 (例: 残り3日) は false
  it('リマインダー対象日でなければ false を返す', () => {
    const now = new Date('2026-07-01T00:00:00Z');
    const trialEndsAt = new Date('2026-07-04T00:00:00Z'); // 残り3日 (対象は5日/1日のみ)
    expect(shouldSendTrialReminder(trialEndsAt, now)).toBe(false);
  });

  // 既に終了済みなら false (二重送信・無意味な送信を防ぐ)
  it('既に終了済みなら false を返す', () => {
    const now = new Date('2026-07-10T00:00:00Z');
    const trialEndsAt = new Date('2026-07-05T00:00:00Z');
    expect(shouldSendTrialReminder(trialEndsAt, now)).toBe(false);
  });
});

describe('renderTrialReminderEmail', () => {
  // 残り1日は「明日」という文言になること (単数系の特別扱い)
  it('残り1日のときは「明日」と表示する', () => {
    const { subject, text } = renderTrialReminderEmail({
      tenantName: 'テスト組織',
      daysRemaining: 1,
      settingsUrl: 'http://localhost:3000/settings',
    });
    expect(subject).toContain('明日');
    expect(text).toContain('明日');
  });

  // 残り5日は「あと5日」という文言になること
  it('残り5日のときは「あと5日」と表示する', () => {
    const { subject, text } = renderTrialReminderEmail({
      tenantName: 'テスト組織',
      daysRemaining: 5,
      settingsUrl: 'http://localhost:3000/settings',
    });
    expect(subject).toContain('あと5日');
    expect(text).toContain('あと5日');
  });

  // HTML 本文にテナント名を安全にエスケープして埋め込むこと (XSS 防止)
  it('テナント名を HTML エスケープする', () => {
    const { html } = renderTrialReminderEmail({
      tenantName: '<script>alert(1)</script>',
      daysRemaining: 5,
      settingsUrl: 'http://localhost:3000/settings',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  // 設定画面 URL が本文とリンクの両方に含まれること
  it('設定画面 URL を本文に含む', () => {
    const { text, html } = renderTrialReminderEmail({
      tenantName: 'テスト組織',
      daysRemaining: 5,
      settingsUrl: 'http://localhost:3000/settings',
    });
    expect(text).toContain('http://localhost:3000/settings');
    expect(html).toContain('http://localhost:3000/settings');
  });
});
