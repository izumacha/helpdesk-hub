// 設定変更監査ログリポジトリ (メモリアダプタ) の単体テスト。
// §4.2 フォローアップ (docs/smb-dx-pivot-plan.md): SSO/LINE 連携/通知チャネル設定の変更が
// 監査ログから漏れていたギャップを埋めるために新設したリポジトリ。record/findAllByTenant の
// 基本動作とテナント分離を検証する。

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
import { SETTINGS_AUDIT_SYSTEM_ACTOR_NAME } from '@/lib/constants';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const USER_A = 'user-a';

let store: Store;
let repos: Repos;

// テナントにユーザーを 1 人投入する (操作者名の解決に使う)
function seedUser(id: string, tenantId: string, name: string) {
  const now = new Date();
  store.users.set(id, {
    id,
    email: `${id}@example.com`,
    name,
    passwordHash: 'x',
    role: 'admin',
    tenantId,
    createdAt: now,
    updatedAt: now,
  });
}

describe('SettingsAuditLogRepository (memory)', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
  });

  // record したログが findAllByTenant で読み出せること (操作者名も解決される)
  it('records and reads back a log entry with the resolved actor name', async () => {
    seedUser(USER_A, TENANT_A, '管理者太郎');
    await repos.settingsAudit.record({
      tenantId: TENANT_A,
      actorId: USER_A,
      action: 'sso_config_update',
    });

    const logs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_A });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('sso_config_update');
    expect(logs[0].actorName).toBe('管理者太郎');
    expect(logs[0].createdAt).toBeInstanceOf(Date);
  });

  // 新しい順に並ぶこと
  it('returns logs newest-first', async () => {
    seedUser(USER_A, TENANT_A, '管理者太郎');
    await repos.settingsAudit.record({
      tenantId: TENANT_A,
      actorId: USER_A,
      action: 'line_config_update',
    });
    // createdAt (Date.now()) が同一ミリ秒にならないよう間隔を空ける
    // (record() は内部で new Date() を使うため、テストからは時刻を差し替えられない)
    await new Promise((resolve) => setTimeout(resolve, 2));
    await repos.settingsAudit.record({
      tenantId: TENANT_A,
      actorId: USER_A,
      action: 'line_config_delete',
    });

    const logs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_A });
    expect(logs.map((l) => l.action)).toEqual(['line_config_delete', 'line_config_update']);
  });

  // 他テナントのログが見えないこと (クロステナント漏洩防止)
  it('does not leak logs across tenants', async () => {
    seedUser(USER_A, TENANT_A, '管理者太郎');
    await repos.settingsAudit.record({
      tenantId: TENANT_A,
      actorId: USER_A,
      action: 'sso_config_delete',
    });

    const logsForB = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_B });
    expect(logsForB).toHaveLength(0);
  });

  // 操作者が見つからない場合は「不明」にフォールバックすること (データ不整合の保護)
  it('falls back to "不明" when the actor user is missing', async () => {
    await repos.settingsAudit.record({
      tenantId: TENANT_A,
      actorId: 'ghost-user',
      action: 'notification_channels_update',
    });

    const logs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_A });
    expect(logs[0].actorName).toBe('不明');
  });

  // §4.2.1 フォローアップ (2026-07-10): before カーソルより後 (同時刻含む) のログは除外され、
  // 監査ページの「さらに読み込む」キーセットページネーションが正しく古いログへ辿れることを確認する
  it('beforeを指定するとその日時より前のログだけに絞り込める', async () => {
    seedUser(USER_A, TENANT_A, '管理者太郎');
    await repos.settingsAudit.record({
      tenantId: TENANT_A,
      actorId: USER_A,
      action: 'line_config_update',
    });
    // record() は内部で new Date() を使うため、テストからは時刻を差し替えられない。
    // 実時間で間隔を空けて「カーソル」と「カーソルより後の記録」を作る
    await new Promise((resolve) => setTimeout(resolve, 5));
    const cursor = new Date();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await repos.settingsAudit.record({
      tenantId: TENANT_A,
      actorId: USER_A,
      action: 'line_config_delete',
    });

    const logs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_A, before: cursor });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('line_config_update');
  });

  // §4.3 フォローアップ (2026-07-10): actorId=null (Stripe Webhook 起因の自動プランダウングレード
  // のようにユーザーが介在しないシステム操作) は「不明」ではなく専用のシステムラベルに解決される
  // (「不明」はデータ不整合、null は正常系という意味の違いを区別する)
  it('actorId が null のときはシステムアクター名に解決される', async () => {
    await repos.settingsAudit.record({
      tenantId: TENANT_A,
      actorId: null,
      action: 'tenant_mode_update',
    });

    const logs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_A });
    expect(logs[0].actorId).toBeNull();
    expect(logs[0].actorName).toBe(SETTINGS_AUDIT_SYSTEM_ACTOR_NAME);
  });
});
