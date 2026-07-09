// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';
// テスト対象 (純粋ヘルパー)
import {
  daysUntilTrialEnds,
  resolveTrialReminderMilestone,
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

  // 時刻成分は無視し、暦日 (UTC) の差分だけで計算する。
  // cron の実行時刻が日によって数時間ずれても同じ日は同じ結果になるようにするため
  // (連続時間の ms 差分をそのまま丸めると、実行時刻のずれで整数値が 1 つ以上飛び、
  // resolveTrialReminderMilestone が対象日を取りこぼす恐れがあった)
  it('時刻成分を無視し暦日の差分で計算する', () => {
    const now = new Date('2026-07-01T23:00:00Z');
    // 4日と2時間後だが、暦日で見れば 2026-07-06 なので 5 日
    const trialEndsAt = new Date('2026-07-06T01:00:00Z');
    expect(daysUntilTrialEnds(trialEndsAt, now)).toBe(5);
  });

  // now の時刻が遅くても (例: cron が数時間遅延しても) 同じ暦日なら結果が変わらないこと
  it('同じ暦日内であれば now の時刻に関わらず同じ結果を返す', () => {
    const trialEndsAt = new Date('2026-07-06T00:00:00Z');
    const earlyRun = daysUntilTrialEnds(trialEndsAt, new Date('2026-07-01T01:00:00Z'));
    const delayedRun = daysUntilTrialEnds(trialEndsAt, new Date('2026-07-01T20:00:00Z'));
    expect(earlyRun).toBe(delayedRun);
    expect(earlyRun).toBe(5);
  });

  // 既に終了済みなら負値を返す (呼び出し側が判定に使う)
  it('終了済みの場合は負値を返す', () => {
    const now = new Date('2026-07-10T00:00:00Z');
    const trialEndsAt = new Date('2026-07-05T00:00:00Z');
    expect(daysUntilTrialEnds(trialEndsAt, now)).toBeLessThan(0);
  });
});

describe('resolveTrialReminderMilestone', () => {
  // 未送信 (lastSentDaysBefore=null) で残り日数がちょうど閾値なら、その閾値を返す
  it.each(TRIAL_REMINDER_DAYS_BEFORE)(
    '未送信で残り%s日ちょうどのときはそのマイルストーンを返す',
    (days) => {
      expect(resolveTrialReminderMilestone(days, null)).toBe(days);
    },
  );

  // 未送信でも、まだどの閾値にも達していなければ null
  it('未送信でも閾値未到達なら null を返す', () => {
    // 残り3日は 5 にも 1 にも達していない (5 は「5 日以下」を満たさない)
    expect(resolveTrialReminderMilestone(6, null)).toBeNull();
  });

  // 既に同じマイルストーンを送信済み (lastSentDaysBefore が閾値以下) なら再送しない
  // (workflow_dispatch の手動再実行や、同じ暦日内の複数回実行での二重送信を防ぐ)
  it('送信済みのマイルストーンは再送しない', () => {
    // 5 日のマイルストーンを既に送信済み。残り日数がまだ 5 のままなら再送しない
    expect(resolveTrialReminderMilestone(5, 5)).toBeNull();
    // 残り 4 日 (5 は送信済み、1 はまだ到達していない) も再送しない
    expect(resolveTrialReminderMilestone(4, 5)).toBeNull();
  });

  // 5 日のマイルストーンを送信済みでも、1 日のマイルストーンには新たに到達すれば送信する
  it('次のマイルストーンに到達すれば送信する', () => {
    expect(resolveTrialReminderMilestone(1, 5)).toBe(1);
  });

  // cron が「5日」の実行タイミングを丸ごと飛ばし、次に確認したときには残り3日だった場合でも、
  // 5 日のマイルストーンがまだ未送信なら「5」として (実際の残り日数を本文に載せて) 遅れて送信する
  // (取りこぼし防止のためのキャッチアップ)
  it('マイルストーンを飛ばして到達した場合は遅れて送信する', () => {
    expect(resolveTrialReminderMilestone(3, null)).toBe(5);
  });

  // 既に終了済み (負の残り日数) でも、まだ何も送っていなければ最も緊急なマイルストーンを返す
  // (呼び出し側は listActiveTrials で trialEndsAt > now のテナントしか渡さないため実運用では
  // 起こりにくいが、関数単体としての境界値を確認する)
  it('負の残り日数でも未送信なら最も緊急なマイルストーンを返す', () => {
    expect(resolveTrialReminderMilestone(-1, null)).toBe(1);
  });

  // すべてのマイルストーンを送信済み (最小の閾値まで送信済み) なら、それ以降は何も返さない
  it('最小のマイルストーンまで送信済みならnullを返す', () => {
    expect(resolveTrialReminderMilestone(0, 1)).toBeNull();
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
