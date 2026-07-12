-- CreateEnum
CREATE TYPE "QuarantineReason" AS ENUM ('plan_gate', 'auth_fail', 'unknown_sender', 'thread_forbidden', 'quota_exceeded');

-- CreateTable
CREATE TABLE "QuarantinedEmail" (
    "id" TEXT NOT NULL,
    "reason" "QuarantineReason" NOT NULL,
    "senderAddress" TEXT NOT NULL,
    "senderName" TEXT,
    "subject" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "QuarantinedEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuarantinedEmail_tenantId_createdAt_idx" ON "QuarantinedEmail"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "QuarantinedEmail" ADD CONSTRAINT "QuarantinedEmail_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
