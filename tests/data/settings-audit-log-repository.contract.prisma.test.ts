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
import { SETTINGS_AUDIT_SYSTEM_ACTOR_NAME } from '@/lib/constants';

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

  // §4.3 フォローアップで追加した5種 (テナントモード切替・拠点CRUD・転送先アドレス再発行) が
  // 実 DB の SettingsAuditAction enum に対して問題なく書き込み・読み出しできること。
  // line_config_delete も含め、このテストまで元々未検証だった値をまとめて確認する
  it('§4.3で追加したアクション種別も含め、全10種が書き込み・読み出しできる', async () => {
    const repos = buildPrismaRepos(prisma);
    const actions = [
      'sso_config_update',
      'sso_config_delete',
      'line_config_update',
      'line_config_delete',
      'notification_channels_update',
      'tenant_mode_update',
      'location_create',
      'location_update',
      'location_delete',
      'inbound_token_regenerate',
    ] as const;
    for (const action of actions) {
      await repos.settingsAudit.record({ tenantId: TENANT_A, actorId: USER_A, action });
    }
    const logs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_A, limit: 100 });
    expect(logs).toHaveLength(actions.length);
    // 記録した全アクションが読み出せること (順序は新しい順なので集合として比較する)
    expect(new Set(logs.map((l) => l.action))).toEqual(new Set(actions));
  });

  // §4.3 フォローアップ (2026-07-10): Stripe Webhook 起因の自動プランダウングレードのように
  // 操作したユーザーが存在しないシステム操作は actorId=null で記録する。SettingsAuditLog.actorId
  // を NOT NULL から nullable に変更したマイグレーションが実 DB でも問題なく動作することを確認する
  it('actorId が null (システム操作) でも記録・読み出しでき、操作者名は固定ラベルになる', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.settingsAudit.record({
      tenantId: TENANT_A,
      actorId: null,
      action: 'tenant_mode_update',
    });

    const logs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_A });
    expect(logs).toHaveLength(1);
    expect(logs[0].actorId).toBeNull();
    // Prisma の include (actor リレーション) も null になるため固定のシステムラベルへ解決される
    expect(logs[0].actorName).toBe(SETTINGS_AUDIT_SYSTEM_ACTOR_NAME);
  });
});
