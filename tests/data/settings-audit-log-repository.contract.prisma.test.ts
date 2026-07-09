// 設定変更監査ログリポジトリ (Prisma アダプタ) の契約テスト。
// §4.2 フォローアップ (docs/smb-dx-pivot-plan.md): SSO/LINE 連携/通知チャネル設定の変更が
// 監査ログから漏れていたギャップを埋めるために新設したリポジトリ。クロステナント分離を含む
// 本番 Prisma 実装の性質を実 DB に対して検証する。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを
// TRUNCATE するため **開発 DB を指さない** こと (CLAUDE.md §テスト)。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma';
import { buildPrismaRepos } from '@/data/adapters/prisma';

const TENANT_A = 'default-tenant';
const TENANT_B = 'tenant-b';
const USER_A = 'user-a';

const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('SettingsAuditLogRepository (prisma adapter)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // 各テスト前に全テーブルを空にし、テナント A / B + テナント A のユーザーを作成する
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "SettingsAuditLog","Attachment","TicketHistory","TicketComment","Notification","FaqCandidate","Ticket","Category","MagicLinkToken","User","Tenant" RESTART IDENTITY CASCADE',
    );
    await prisma.tenant.create({ data: { id: TENANT_A, name: 'デフォルト組織', mode: 'lite' } });
    await prisma.tenant.create({ data: { id: TENANT_B, name: '別組織', mode: 'lite' } });
    await prisma.user.create({
      data: {
        id: USER_A,
        email: 'admin@example.com',
        name: '管理者太郎',
        passwordHash: 'x',
        role: 'admin',
        tenantId: TENANT_A,
      },
    });
  });

  // record したログが findAllByTenant で新しい順に読み出せること
  it('record したログを新しい順に読み出せる', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.settingsAudit.record({
      tenantId: TENANT_A,
      actorId: USER_A,
      action: 'sso_config_update',
    });
    await repos.settingsAudit.record({
      tenantId: TENANT_A,
      actorId: USER_A,
      action: 'sso_config_delete',
    });

    const logs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_A });
    expect(logs).toHaveLength(2);
    expect(logs[0].actorName).toBe('管理者太郎');
    // 新しい順 (2 件目に record した sso_config_delete が先頭)
    expect(logs[0].action).toBe('sso_config_delete');
  });

  // クロステナント分離: テナント A のログはテナント B から取得できない
  it('テナント A のログはテナント B からは取得できない (クロステナント分離)', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.settingsAudit.record({
      tenantId: TENANT_A,
      actorId: USER_A,
      action: 'line_config_update',
    });

    const logsForB = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_B });
    expect(logsForB).toHaveLength(0);
  });

  // limit オプションで取得件数を絞れる
  it('limit で取得件数を絞れる', async () => {
    const repos = buildPrismaRepos(prisma);
    for (let i = 0; i < 3; i++) {
      await repos.settingsAudit.record({
        tenantId: TENANT_A,
        actorId: USER_A,
        action: 'notification_channels_update',
      });
    }

    const logs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_A, limit: 2 });
    expect(logs).toHaveLength(2);
  });
});
