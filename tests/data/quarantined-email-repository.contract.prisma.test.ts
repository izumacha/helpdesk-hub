// 隔離済み受信メールリポジトリ (Prisma アダプタ) の契約テスト。
// §3.2 フォローアップ再訪 (docs/smb-dx-pivot-plan.md): 未登録送信者・プラン未対応・認証失敗等で
// 起票されなかった受信メールが admin から一切確認できなかったギャップを埋めるために新設した
// リポジトリ。クロステナント分離を含む本番 Prisma 実装の性質を実 DB に対して検証する。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを
// TRUNCATE するため **開発 DB を指さない** こと (CLAUDE.md §テスト)。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma';
import { buildPrismaRepos } from '@/data/adapters/prisma';

const TENANT_A = 'default-tenant';
const TENANT_B = 'tenant-b';

const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('QuarantinedEmailRepository (prisma adapter)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // 各テスト前に全テーブルを空にし、テナント A / B を作成する
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "QuarantinedEmail","SettingsAuditLog","Attachment","TicketHistory","TicketComment","Notification","FaqCandidate","Ticket","Category","MagicLinkToken","User","Tenant" RESTART IDENTITY CASCADE',
    );
    await prisma.tenant.create({ data: { id: TENANT_A, name: 'デフォルト組織', mode: 'lite' } });
    await prisma.tenant.create({ data: { id: TENANT_B, name: '別組織', mode: 'lite' } });
  });

  // record した記録が findAllByTenant で新しい順に読み出せること
  it('record した記録を新しい順に読み出せる', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.quarantinedEmails.record({
      tenantId: TENANT_A,
      reason: 'plan_gate',
      senderAddress: 'a@example.com',
      senderName: 'A',
      subject: '1件目',
    });
    await repos.quarantinedEmails.record({
      tenantId: TENANT_A,
      reason: 'unknown_sender',
      senderAddress: 'b@example.com',
      senderName: 'B',
      subject: '2件目',
    });

    const rows = await repos.quarantinedEmails.findAllByTenant({ tenantId: TENANT_A });
    expect(rows).toHaveLength(2);
    // 新しい順 (2 件目に record した行が先頭)
    expect(rows[0].subject).toBe('2件目');
    expect(rows[0].reason).toBe('unknown_sender');
  });

  // クロステナント分離: テナント A の記録はテナント B から取得できない
  it('テナント A の記録はテナント B からは取得できない (クロステナント分離)', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.quarantinedEmails.record({
      tenantId: TENANT_A,
      reason: 'auth_fail',
      senderAddress: 'a@example.com',
      senderName: 'A',
      subject: 'テスト',
    });

    const rowsForB = await repos.quarantinedEmails.findAllByTenant({ tenantId: TENANT_B });
    expect(rowsForB).toHaveLength(0);
  });

  // limit オプションで取得件数を絞れる
  it('limit で取得件数を絞れる', async () => {
    const repos = buildPrismaRepos(prisma);
    for (let i = 0; i < 3; i++) {
      await repos.quarantinedEmails.record({
        tenantId: TENANT_A,
        reason: 'quota_exceeded',
        senderAddress: `u${i}@example.com`,
        senderName: `U${i}`,
        subject: `件名${i}`,
      });
    }

    const rows = await repos.quarantinedEmails.findAllByTenant({ tenantId: TENANT_A, limit: 2 });
    expect(rows).toHaveLength(2);
  });

  // 全 5 種の QuarantineReason が実 DB の enum に対して問題なく書き込み・読み出しできること
  it('全5種の隔離理由が書き込み・読み出しできる', async () => {
    const repos = buildPrismaRepos(prisma);
    const reasons = [
      'plan_gate',
      'auth_fail',
      'unknown_sender',
      'thread_forbidden',
      'quota_exceeded',
    ] as const;
    for (const reason of reasons) {
      await repos.quarantinedEmails.record({
        tenantId: TENANT_A,
        reason,
        senderAddress: 'a@example.com',
        senderName: 'A',
        subject: reason,
      });
    }
    const rows = await repos.quarantinedEmails.findAllByTenant({ tenantId: TENANT_A, limit: 100 });
    expect(rows).toHaveLength(reasons.length);
    expect(new Set(rows.map((r) => r.reason))).toEqual(new Set(reasons));
  });

  // senderName が null (ヘッダから表示名を取れなかった場合) でも書き込み・読み出しできること
  it('senderName が null でも記録・読み出しできる', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.quarantinedEmails.record({
      tenantId: TENANT_A,
      reason: 'unknown_sender',
      senderAddress: 'noheader@example.com',
      senderName: null,
      subject: 'テスト',
    });

    const rows = await repos.quarantinedEmails.findAllByTenant({ tenantId: TENANT_A });
    expect(rows[0].senderName).toBeNull();
  });

  // createdAt が完全に同一の行があっても id タイブレーカーによりページ境界で
  // 行を取りこぼさないこと (settings-audit-log-repository の契約テストと同じ観点)
  it('createdAtが同一の行はidで安定した順序に並び、beforeカーソルで取りこぼさない', async () => {
    const sameInstant = new Date('2026-01-01T00:00:00.000Z');
    await prisma.quarantinedEmail.create({
      data: {
        id: 'qte_b',
        tenantId: TENANT_A,
        reason: 'plan_gate',
        senderAddress: 'b@example.com',
        senderName: 'B',
        subject: 'B',
        createdAt: sameInstant,
      },
    });
    await prisma.quarantinedEmail.create({
      data: {
        id: 'qte_a',
        tenantId: TENANT_A,
        reason: 'plan_gate',
        senderAddress: 'a@example.com',
        senderName: 'A',
        subject: 'A',
        createdAt: sameInstant,
      },
    });
    await prisma.quarantinedEmail.create({
      data: {
        id: 'qte_c',
        tenantId: TENANT_A,
        reason: 'plan_gate',
        senderAddress: 'c@example.com',
        senderName: 'C',
        subject: 'C',
        createdAt: sameInstant,
      },
    });

    const repos = buildPrismaRepos(prisma);
    const page1 = await repos.quarantinedEmails.findAllByTenant({ tenantId: TENANT_A, limit: 2 });
    expect(page1.map((r) => r.id)).toEqual(['qte_c', 'qte_b']);

    const page2 = await repos.quarantinedEmails.findAllByTenant({
      tenantId: TENANT_A,
      before: { createdAt: sameInstant, id: 'qte_b' },
    });
    expect(page2.map((r) => r.id)).toEqual(['qte_a']);
  });

  // テナント削除で隔離記録も連鎖削除されること (onDelete: Cascade)
  it('テナント削除で隔離記録も連鎖削除される', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.quarantinedEmails.record({
      tenantId: TENANT_B,
      reason: 'plan_gate',
      senderAddress: 'a@example.com',
      senderName: 'A',
      subject: 'テスト',
    });

    await prisma.tenant.delete({ where: { id: TENANT_B } });

    const remaining = await prisma.quarantinedEmail.findMany({ where: { tenantId: TENANT_B } });
    expect(remaining).toHaveLength(0);
  });
});
