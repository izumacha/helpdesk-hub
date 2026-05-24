-- Phase 1 / 添付ファイル機能 (docs/smb-dx-pivot-plan.md §3 / Phase 1):
-- スマホで撮った写真をチケット作成時とコメント投稿時に添付できるようにする。
-- ストレージ実体 (local | s3) は storage カラムで切替可能とし、当面は local のみ運用する。

-- 添付ファイルの保存先種別 (将来 S3 互換ストレージへの差し替え用)
CREATE TYPE "AttachmentStorage" AS ENUM ('local', 's3');

-- 添付ファイル本体テーブル
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "commentId" TEXT,
    "uploaderId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "originalName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "storage" "AttachmentStorage" NOT NULL DEFAULT 'local',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- チケット詳細での一覧取得用インデックス
CREATE INDEX "Attachment_ticketId_idx" ON "Attachment"("ticketId");

-- コメント単位での添付一覧用インデックス
CREATE INDEX "Attachment_commentId_idx" ON "Attachment"("commentId");

-- テナントスコープ検索用インデックス (クロステナント遮断テスト用)
CREATE INDEX "Attachment_tenantId_idx" ON "Attachment"("tenantId");

-- 外部キー (チケット削除で添付も連鎖削除)
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 外部キー (コメント削除で添付も連鎖削除)
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "TicketComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 外部キー (アップローダーユーザー。ユーザー削除は明示的にハンドリングするため Restrict)
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 外部キー (テナント削除で添付も連鎖削除)
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
