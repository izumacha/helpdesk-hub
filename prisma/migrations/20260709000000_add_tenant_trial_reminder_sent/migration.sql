-- §7.2.1 Free trial 終了リマインダーの冪等化フラグを追加する。
-- 直近に送信済みのマイルストーン (5 | 1) を記録し、cron の手動再実行・遅延・欠落があっても
-- 二重送信/取りこぼしを防ぐ。null なら未送信 (既存テナントはすべて null で補完される)。
ALTER TABLE "Tenant" ADD COLUMN "trialReminderLastSentDaysBefore" INTEGER;
