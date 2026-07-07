-- §7.2「30日間の Free trial (Standard 相当)」用のトライアル終了日時カラムを追加する。
-- null ならトライアル対象外/終了済み。既存テナントはすべて null (= トライアル無し) で補完される。
ALTER TABLE "Tenant" ADD COLUMN "trialEndsAt" TIMESTAMP(3);
