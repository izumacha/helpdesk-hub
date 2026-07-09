-- §4 Phase 2.1 フォローアップ: LINE 連携コード処理 (紐付け成功/競合) の冪等化記録を
-- インプロセス Map から永続テーブルへ切り替える。
-- LINE メッセージ ID はプラットフォーム全体で一意なため tenantId スコープは不要。
CREATE TABLE "LineLinkCodeRef" (
    "id" TEXT NOT NULL,
    "lineMessageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LineLinkCodeRef_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LineLinkCodeRef_lineMessageId_key" ON "LineLinkCodeRef"("lineMessageId");
