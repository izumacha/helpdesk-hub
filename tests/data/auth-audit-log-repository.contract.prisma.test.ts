// 認証イベント監査ログリポジトリ (Prisma アダプタ) の契約テスト。
// 課題棚卸し (2026-07-26) の否認防止ギャップ対応で新設。record が実 DB の AuthAuditLog へ
// 追記されること・全 enum 値が書き込めること・null 識別子を保持できることを検証する。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach でテーブルを
// TRUNCATE するため **開発 DB を指さない** こと (CLAUDE.md §テスト)。
// 注意: 契約テスト用 DB は `prisma db push` でスキーマ同期されるため、マイグレーション
// 20260726000100_add_audit_log_immutability の追記専用トリガ (UPDATE/DELETE 禁止) は
// この DB には存在しない。トリガ自体の検証は migrate deploy 済み環境の責務とする。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma';
import { buildPrismaRepos } from '@/data/adapters/prisma';

const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('AuthAuditLogRepository (prisma adapter)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // 各テスト前に AuthAuditLog を空にする (FK を持たないテーブルなので単独 TRUNCATE でよい)
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "AuthAuditLog" RESTART IDENTITY CASCADE');
  });

  // record した行が実 DB に追記されること
  it('record した認証イベントが実 DB に追記される', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.authAudit.record({
      event: 'password_login_success',
      email: 'agent@example.com',
      userId: 'u1',
      tenantId: 't1',
    });

    const rows = await prisma.authAuditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: 'password_login_success',
      email: 'agent@example.com',
      userId: 'u1',
      tenantId: 't1',
    });
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  // 不在ユーザーの失敗イベント (null 識別子) を保持できること
  it('userId/tenantId が null の失敗イベントも記録できる', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.authAudit.record({
      event: 'password_login_failure',
      email: 'ghost@example.com',
      userId: null,
      tenantId: null,
    });

    const rows = await prisma.authAuditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBeNull();
    expect(rows[0].tenantId).toBeNull();
  });

  // 全イベント種別が実 DB の enum に対して書き込めること (schema.prisma と domain 型の同期検証)
  it('AuthAuditEvent の全5種が書き込み・読み出しできる', async () => {
    const repos = buildPrismaRepos(prisma);
    const events = [
      'password_login_success',
      'password_login_failure',
      'magic_link_login_success',
      'sso_login_success',
      'sso_assertion_accepted',
    ] as const;
    for (const event of events) {
      await repos.authAudit.record({
        event,
        email: 'agent@example.com',
        userId: null,
        tenantId: null,
      });
    }
    const rows = await prisma.authAuditLog.findMany();
    expect(rows).toHaveLength(events.length);
    expect(new Set(rows.map((r) => r.event))).toEqual(new Set(events));
  });
});
