-- フォローアップ (2026-07-21): 隔離メール発生を admin に知らせる通知 (NotificationType.quarantined)
-- の送信間隔を空けるための冪等化フィールド。スパム流入等で短時間に大量の隔離が発生しても
-- テナントあたり 24 時間に 1 回しか通知しないようにする (trialReminderLastSentDaysBefore と
-- 同種の「直近送信時刻」記録)。
ALTER TABLE "Tenant" ADD COLUMN "quarantineNotifiedAt" TIMESTAMP(3);
