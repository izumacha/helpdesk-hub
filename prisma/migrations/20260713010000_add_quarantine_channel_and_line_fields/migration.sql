-- フォローアップ (2026-07-13): 監査で発見したギャップの解消。LINE 取り込みも
-- 「console.warn のサーバーログにしか残らず admin から確認できない」不備を抱えていたため、
-- QuarantinedEmail テーブルをチャネル共通の隔離記録として拡張する。

-- AlterEnum: LINE 専用の隔離理由 (テナントに担当者が 1 人もいない) を追加する
ALTER TYPE "QuarantineReason" ADD VALUE 'no_agents';

-- CreateEnum: 隔離記録の発生元チャネル
CREATE TYPE "QuarantineChannel" AS ENUM ('email', 'line');

-- AlterTable: channel を追加 (既存行は全てメール由来なので既定値 'email' を設定)し、
-- LINE 専用の lineUserId を追加。メール専用だった senderAddress/subject は
-- LINE 記録では埋まらないため NOT NULL 制約を外す
ALTER TABLE "QuarantinedEmail" ADD COLUMN "channel" "QuarantineChannel" NOT NULL DEFAULT 'email';
ALTER TABLE "QuarantinedEmail" ADD COLUMN "lineUserId" TEXT;
ALTER TABLE "QuarantinedEmail" ALTER COLUMN "senderAddress" DROP NOT NULL;
ALTER TABLE "QuarantinedEmail" ALTER COLUMN "subject" DROP NOT NULL;
