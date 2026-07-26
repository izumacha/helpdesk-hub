-- CreateEnum
CREATE TYPE "AuthAuditEvent" AS ENUM ('password_login_success', 'password_login_failure', 'magic_link_login_success', 'sso_login_success', 'sso_assertion_accepted');

-- CreateTable
CREATE TABLE "AuthAuditLog" (
    "id" TEXT NOT NULL,
    "event" "AuthAuditEvent" NOT NULL,
    "email" TEXT NOT NULL,
    "userId" TEXT,
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthAuditLog_tenantId_createdAt_idx" ON "AuthAuditLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuthAuditLog_email_createdAt_idx" ON "AuthAuditLog"("email", "createdAt");
