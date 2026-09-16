-- docs/smb-dx-pivot-plan.md §4.29 / §6.1 Pro「AI FAQ 自己解決」: 起票前の FAQ 提案 (AI デフレクション) の
-- 計測記録。提示 (suggested) → 解決 (resolved) / 起票継続 (proceeded) の決着と、候補が無かった
-- (no_match) ことを記録し、テナントごとの自己解決率を算出できるようにする。
-- 依頼者の入力本文 (件名・内容) は意図的に保存しない (§9 最小公開。計測に必要なのは件数と決着だけ)。
CREATE TYPE "DeflectionOutcome" AS ENUM ('suggested', 'resolved', 'proceeded', 'no_match');

CREATE TABLE "DeflectionEvent" (
    "id" TEXT NOT NULL,
    "outcome" "DeflectionOutcome" NOT NULL DEFAULT 'suggested',
    "candidateCount" INTEGER NOT NULL,
    "matchedFaqId" TEXT,
    "ticketId" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "DeflectionEvent_pkey" PRIMARY KEY ("id")
);

-- テナント別の期間集計 (自己解決率) 用の複合インデックス
CREATE INDEX "DeflectionEvent_tenantId_createdAt_idx" ON "DeflectionEvent"("tenantId", "createdAt");

-- 外部キー (テナント削除で計測記録も連鎖削除)。userId / matchedFaqId / ticketId は計測用の
-- ゆるい参照のため FK を張らない (チケットや FAQ の削除で自己解決率の分母が消えないようにする)
ALTER TABLE "DeflectionEvent" ADD CONSTRAINT "DeflectionEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
