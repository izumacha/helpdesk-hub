-- Ticket の (tenantId, firstRespondedAt) / (tenantId, resolvedAt) 複合インデックスを追加する。
-- 追加の理由と、どのクエリのために効かせているかは prisma/schema.prisma の
-- Ticket モデルのコメントが唯一の説明 (ここに写すと片方だけ古くなるため)。
--
-- 運用上の注意: Prisma のマイグレーションは CREATE INDEX を CONCURRENTLY なしで実行するため、
-- 作成中は当該テーブルへの書き込みがブロックされる。チケット行が非常に多い環境へ適用する場合は、
-- 反映の時間帯に注意するか、手動で CONCURRENTLY 版を作成してから
-- `prisma migrate resolve --applied` で適用済みとして記録すること。
CREATE INDEX "Ticket_tenantId_firstRespondedAt_idx" ON "Ticket"("tenantId", "firstRespondedAt");
CREATE INDEX "Ticket_tenantId_resolvedAt_idx" ON "Ticket"("tenantId", "resolvedAt");
