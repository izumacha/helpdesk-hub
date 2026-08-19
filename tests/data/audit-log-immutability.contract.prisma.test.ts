// 監査ログの追記専用トリガ (prisma/migrations/20260726000100_add_audit_log_immutability) の
// 契約テスト。UPDATE の無条件拒否・DELETE の原則拒否・break-glass 経路
// (SET LOCAL helpdesk.allow_audit_delete = 'on' + スーパーユーザー権限) を実 DB で検証する。
//
// 前提: 契約テスト用 DB は `prisma migrate deploy` でスキーマ同期されていること (CLAUDE.md §テスト。
// `db push` はマイグレーション SQL を実行しないためトリガが作成されず、このテストは失敗する)。
// CI の contract ジョブは migrate deploy + postgres スーパーユーザー接続なので条件を満たす。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach でテーブルを
// TRUNCATE するため **開発 DB を指さない** こと (CLAUDE.md §テスト)。
// なお TRUNCATE 自体は行レベルトリガの対象外 (PostgreSQL 仕様) なのでリセットは常に成功する。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma';
// Prisma 7 はドライバアダプタ必須。生成は共通ファクトリへ寄せる
import { createPrismaClient } from '@/lib/prisma-client';

const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

// テストで使う固定の監査行 ID
const ROW_ID = 'aal_immutable_1';

describe.runIf(SHOULD_RUN)('監査ログの追記専用トリガ (audit log immutability)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // 各テスト前にテーブルを空にし、検証対象の監査行を 1 件作る
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "AuthAuditLog" CASCADE');
    await prisma.authAuditLog.create({
      data: {
        id: ROW_ID,
        event: 'password_login_success',
        email: 'agent@example.com',
        userId: 'u1',
        tenantId: 't1',
      },
    });
  });

  // UPDATE (事後改竄) はトリガで拒否されること
  it('UPDATE は拒否される', async () => {
    await expect(
      prisma.authAuditLog.update({ where: { id: ROW_ID }, data: { email: 'tampered@example.com' } }),
    ).rejects.toThrow(/append-only/);
    // 行は書き換わっていない
    const row = await prisma.authAuditLog.findUniqueOrThrow({ where: { id: ROW_ID } });
    expect(row.email).toBe('agent@example.com');
  });

  // 素の DELETE (break-glass フラグなし) は拒否されること
  it('break-glass フラグの無い DELETE は拒否される', async () => {
    await expect(prisma.authAuditLog.delete({ where: { id: ROW_ID } })).rejects.toThrow(
      /append-only/,
    );
    // 行は残っている
    expect(await prisma.authAuditLog.count()).toBe(1);
  });

  // break-glass (SET LOCAL + スーパーユーザー) のトランザクション内なら DELETE できること。
  // e2e/cleanup.ts の deleteTenantsForCleanup が依存する経路の実 DB 検証
  it('break-glass トランザクション内の DELETE は許可される', async () => {
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL helpdesk.allow_audit_delete = 'on'`),
      prisma.authAuditLog.deleteMany({ where: { id: ROW_ID } }),
    ]);
    // 行が消えている (break-glass が機能した)
    expect(await prisma.authAuditLog.count()).toBe(0);
  });

  // break-glass フラグがあっても UPDATE は拒否されること (改竄には例外を設けない)
  it('break-glass フラグがあっても UPDATE は拒否される', async () => {
    await expect(
      prisma.$transaction([
        prisma.$executeRawUnsafe(`SET LOCAL helpdesk.allow_audit_delete = 'on'`),
        prisma.authAuditLog.update({
          where: { id: ROW_ID },
          data: { email: 'tampered@example.com' },
        }),
      ]),
    ).rejects.toThrow(/append-only/);
    // 行は書き換わっていない
    const row = await prisma.authAuditLog.findUniqueOrThrow({ where: { id: ROW_ID } });
    expect(row.email).toBe('agent@example.com');
  });

  // SET LOCAL はトランザクション終了で失効すること (フラグの取り残しで保護が緩まない)
  it('break-glass フラグはトランザクション終了後に失効する', async () => {
    // break-glass トランザクションを 1 度実行する (何も消さない)
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL helpdesk.allow_audit_delete = 'on'`),
    ]);
    // その後の素の DELETE は引き続き拒否される
    await expect(prisma.authAuditLog.delete({ where: { id: ROW_ID } })).rejects.toThrow(
      /append-only/,
    );
  });
});
